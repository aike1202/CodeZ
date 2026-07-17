use std::{
    error::Error,
    io::{self, Read, Write},
    path::Path,
    process::Command as ProcessCommand,
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::{
    fs::{self, OpenOptions},
    os::windows::fs::OpenOptionsExt,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use codez_platform::{PtyEvent, PtyManager, pty::PTY_EVENT_QUEUE_CAPACITY};
use portable_pty::{Child, CommandBuilder, ExitStatus, MasterPty, PtySize, native_pty_system};

type TestResult<T = ()> = Result<T, Box<dyn Error + Send + Sync>>;

const INITIAL_SIZE: PtySize = PtySize {
    rows: 24,
    cols: 80,
    pixel_width: 0,
    pixel_height: 0,
};
const RESIZED: PtySize = PtySize {
    rows: 41,
    cols: 132,
    pixel_width: 0,
    pixel_height: 0,
};
const WAIT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CAPTURED_OUTPUT_BYTES: usize = 256 * 1024;
#[cfg(windows)]
const PROCESS_TREE_FIXTURE_REQUEST: &str = "process-tree-fixture.request";
#[cfg(windows)]
const WINDOWS_CTRL_C_KEY_EVENTS: &[u8] = b"\x1b[17;29;0;1;8;1_\
\x1b[67;46;3;1;8;1_\
\x1b[67;46;3;0;8;1_\
\x1b[17;29;0;0;0;1_";

struct PtyProbe {
    master: Option<Box<dyn MasterPty + Send>>,
    child: Option<Box<dyn Child + Send + Sync>>,
    writer: Option<Box<dyn Write + Send>>,
    output: Vec<u8>,
    output_rx: Receiver<Vec<u8>>,
    reader_done_rx: Receiver<io::Result<()>>,
    reader_thread: Option<JoinHandle<()>>,
    #[cfg(windows)]
    _shell_environment: TestDirectory,
}

impl PtyProbe {
    fn spawn(mut command: CommandBuilder) -> TestResult<Self> {
        #[cfg(windows)]
        let shell_environment = {
            let directory = TestDirectory::create()?;
            fs::create_dir_all(
                directory
                    .path()
                    .join("Microsoft")
                    .join("Windows")
                    .join("PowerShell")
                    .join("PSReadLine"),
            )?;
            command.env("APPDATA", directory.path());
            directory
        };

        let pair = native_pty_system().openpty(INITIAL_SIZE)?;
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let child = pair.slave.spawn_command(command)?;
        drop(pair.slave);

        let (output_tx, output_rx) = mpsc::sync_channel::<Vec<u8>>(64);
        let (reader_done_tx, reader_done_rx) = mpsc::channel();
        let reader_thread = thread::spawn(move || {
            let result = (|| -> io::Result<()> {
                let mut chunk = [0_u8; 4096];
                loop {
                    let read = reader.read(&mut chunk)?;
                    if read == 0 {
                        return Ok(());
                    }
                    if output_tx.send(chunk[..read].to_vec()).is_err() {
                        return Ok(());
                    }
                }
            })();
            let _ = reader_done_tx.send(result);
        });

        let mut probe = Self {
            master: Some(pair.master),
            child: Some(child),
            writer: Some(writer),
            output: Vec::new(),
            output_rx,
            reader_done_rx,
            reader_thread: Some(reader_thread),
            #[cfg(windows)]
            _shell_environment: shell_environment,
        };

        #[cfg(windows)]
        {
            probe.wait_for_output("\u{1b}[6n")?;
            probe.write_bytes(b"\x1b[1;1R")?;
        }

        Ok(probe)
    }

    fn write_bytes(&mut self, input: &[u8]) -> TestResult {
        let writer = self
            .writer
            .as_mut()
            .ok_or("PTY writer is no longer available")?;
        writer.write_all(input)?;
        writer.flush()?;
        Ok(())
    }

    fn write_line(&mut self, input: &str) -> TestResult {
        self.write_bytes(input.as_bytes())?;
        #[cfg(windows)]
        self.write_bytes(b"\r")?;
        #[cfg(not(windows))]
        self.write_bytes(b"\n")?;
        Ok(())
    }

    #[cfg(windows)]
    fn write_ctrl_c(&mut self) -> TestResult {
        self.write_bytes(WINDOWS_CTRL_C_KEY_EVENTS)
    }

    fn resize(&self, size: PtySize) -> TestResult {
        self.master
            .as_ref()
            .ok_or("PTY master is no longer available")?
            .resize(size)?;
        Ok(())
    }

    fn reported_size(&self) -> TestResult<PtySize> {
        Ok(self
            .master
            .as_ref()
            .ok_or("PTY master is no longer available")?
            .get_size()?)
    }

    fn wait_for_output(&mut self, needle: &str) -> TestResult<String> {
        self.wait_for_value(needle, |output| {
            output.contains(needle).then(|| output.to_owned())
        })
    }

    fn wait_for_value<T>(
        &mut self,
        label: &str,
        mut find: impl FnMut(&str) -> Option<T>,
    ) -> TestResult<T> {
        let deadline = Instant::now() + WAIT_TIMEOUT;
        loop {
            let output = String::from_utf8_lossy(&self.output);
            if let Some(value) = find(&output) {
                return Ok(value);
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(
                    format!("timed out waiting for {label}; captured output: {output:?}").into(),
                );
            }

            match self.output_rx.recv_timeout(remaining) {
                Ok(chunk) => {
                    if self.output.len() + chunk.len() > MAX_CAPTURED_OUTPUT_BYTES {
                        return Err(format!(
                            "PTY output exceeded the {MAX_CAPTURED_OUTPUT_BYTES}-byte probe limit"
                        )
                        .into());
                    }
                    self.output.extend_from_slice(&chunk);
                }
                Err(RecvTimeoutError::Timeout) => {
                    return Err(format!(
                        "timed out waiting for {label}; captured output: {:?}",
                        String::from_utf8_lossy(&self.output)
                    )
                    .into());
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(format!("PTY reader closed before {label} was observed").into());
                }
            }
        }
    }

    fn wait_for_exit(&mut self) -> TestResult<ExitStatus> {
        let deadline = Instant::now() + WAIT_TIMEOUT;
        loop {
            let child = self
                .child
                .as_mut()
                .ok_or("PTY child is no longer available")?;
            if let Some(status) = child.try_wait()? {
                return Ok(status);
            }
            if Instant::now() >= deadline {
                return Err("PTY child did not exit before the timeout".into());
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn exit_cleanly(&mut self) -> TestResult<ExitStatus> {
        self.write_line("exit 0")?;
        self.wait_for_exit()
    }

    fn finish(mut self) -> TestResult<bool> {
        self.writer.take();
        self.child.take();
        self.master.take();

        let reader_result = self
            .reader_done_rx
            .recv_timeout(WAIT_TIMEOUT)
            .map_err(|_| "PTY reader did not close after the child and master were dropped")?;
        reader_result?;

        let reader_thread = self
            .reader_thread
            .take()
            .ok_or("PTY reader thread was already joined")?;
        reader_thread
            .join()
            .map_err(|_| "PTY reader thread panicked")?;
        Ok(true)
    }
}

impl Drop for PtyProbe {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let is_running = child.try_wait().ok().flatten().is_none();
            if is_running {
                if let Some(pid) = child.process_id() {
                    let _ = kill_process_tree(pid);
                }
                let _ = child.kill();
            }
        }

        self.writer.take();
        self.child.take();
        self.master.take();

        if self
            .reader_done_rx
            .recv_timeout(Duration::from_secs(2))
            .is_ok()
        {
            if let Some(reader_thread) = self.reader_thread.take() {
                let _ = reader_thread.join();
            }
        }
    }
}

fn shell_command(cwd: Option<&Path>) -> CommandBuilder {
    #[cfg(windows)]
    let mut command = {
        let mut command = CommandBuilder::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NoExit",
            "-Command",
            "$u = [System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding = $u; [Console]::OutputEncoding = $u; $OutputEncoding = $u; if (Get-Module PSReadLine) { Remove-Module PSReadLine }",
        ]);
        command
    };

    #[cfg(not(windows))]
    let mut command = {
        let mut command = CommandBuilder::new("bash");
        command.args(["--noprofile", "--norc"]);
        command
    };

    if let Some(cwd) = cwd {
        command.cwd(cwd);
    }
    command
}

fn spawn_shell(cwd: Option<&Path>) -> TestResult<PtyProbe> {
    PtyProbe::spawn(shell_command(cwd))
}

#[cfg(windows)]
fn command_prompt(cwd: Option<&Path>) -> CommandBuilder {
    let mut command = CommandBuilder::new("cmd.exe");
    command.args(["/D", "/Q"]);
    if let Some(cwd) = cwd {
        command.cwd(cwd);
    }
    command
}

#[cfg(windows)]
fn production_powershell(cwd: Option<&Path>) -> CommandBuilder {
    let mut command = CommandBuilder::new("powershell.exe");
    command.args([
        "-NoExit",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    ]);
    if let Some(cwd) = cwd {
        command.cwd(cwd);
    }
    command
}

#[cfg(not(windows))]
fn process_exists(pid: u32) -> bool {
    ProcessCommand::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(windows)]
fn kill_process_tree(pid: u32) -> TestResult {
    let pid = pid.to_string();
    let output = ProcessCommand::new("taskkill")
        .args(["/PID", &pid, "/T", "/F"])
        .output()?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "taskkill failed for process {pid}: {}",
        String::from_utf8_lossy(&output.stderr)
    )
    .into())
}

#[cfg(not(windows))]
fn kill_process_tree(pid: u32) -> TestResult {
    let process_group = format!("-{pid}");
    let status = ProcessCommand::new("kill")
        .args(["-TERM", "--", &process_group])
        .status()?;
    if status.success() || !process_exists(pid) {
        Ok(())
    } else {
        Err(format!("failed to terminate process group {pid}").into())
    }
}

#[cfg(not(windows))]
fn wait_for_process_exit(pid: u32) -> TestResult {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    while process_exists(pid) {
        if Instant::now() >= deadline {
            return Err(format!("process {pid} did not exit before the timeout").into());
        }
        thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

#[cfg(windows)]
fn wait_for_child_ready(path: &Path) -> TestResult<u32> {
    const PREFIX: &str = "CODEZ_CHILD_READY:";
    const SUFFIX: &str = ":END";

    let deadline = Instant::now() + WAIT_TIMEOUT;
    loop {
        match fs::read_to_string(path) {
            Ok(contents) => {
                if let Some(pid) = contents
                    .strip_prefix(PREFIX)
                    .and_then(|value| value.strip_suffix(SUFFIX))
                    .and_then(|value| value.parse().ok())
                {
                    return Ok(pid);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }

        if Instant::now() >= deadline {
            return Err(format!(
                "child process did not publish a complete ready marker at {}",
                path.display()
            )
            .into());
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(windows)]
fn exclusive_lock_is_held(path: &Path) -> TestResult<bool> {
    match OpenOptions::new().read(true).write(true).open(path) {
        Ok(_) => Ok(false),
        Err(error) if error.raw_os_error() == Some(32) => Ok(true),
        Err(error) => Err(error.into()),
    }
}

#[cfg(windows)]
fn wait_for_exclusive_lock_release(path: &Path) -> TestResult<bool> {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    loop {
        match OpenOptions::new().read(true).write(true).open(path) {
            Ok(_) => return Ok(true),
            Err(error) if error.raw_os_error() == Some(32) => {}
            Err(error) => return Err(error.into()),
        }

        if Instant::now() >= deadline {
            return Err(format!(
                "child process still held its exclusive lock at {}",
                path.display()
            )
            .into());
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(windows)]
async fn wait_for_terminal_marker(
    manager: &PtyManager,
    events: &mut tokio::sync::mpsc::Receiver<PtyEvent>,
    terminal_id: &str,
    marker: &str,
) -> TestResult {
    let mut output = Vec::new();
    let result = tokio::time::timeout(WAIT_TIMEOUT, async {
        loop {
            match events.recv().await {
                Some(PtyEvent::Output { id, sequence, data }) if id == terminal_id => {
                    manager.acknowledge(terminal_id, sequence)?;
                    if output.len() + data.len() > MAX_CAPTURED_OUTPUT_BYTES {
                        return Err("PTY manager output exceeded the probe limit".into());
                    }
                    output.extend_from_slice(&data);
                    if String::from_utf8_lossy(&output).contains(marker) {
                        return Ok(());
                    }
                }
                Some(PtyEvent::Exit { id, .. }) if id == terminal_id => {
                    return Err("PTY manager exited before the expected marker".into());
                }
                Some(_) => {}
                None => return Err("PTY manager event channel closed unexpectedly".into()),
            }
        }
    })
    .await;

    match result {
        Ok(result) => result,
        Err(_) => Err(format!(
            "timed out waiting for {marker:?}; captured output: {:?}",
            String::from_utf8_lossy(&output)
        )
        .into()),
    }
}

#[cfg(windows)]
async fn wait_for_terminal_pid(
    manager: &PtyManager,
    events: &mut tokio::sync::mpsc::Receiver<PtyEvent>,
    terminal_id: &str,
) -> TestResult<u32> {
    let mut output = Vec::new();
    tokio::time::timeout(WAIT_TIMEOUT, async {
        loop {
            match events.recv().await {
                Some(PtyEvent::Output { id, sequence, data }) if id == terminal_id => {
                    manager.acknowledge(terminal_id, sequence)?;
                    if output.len() + data.len() > MAX_CAPTURED_OUTPUT_BYTES {
                        return Err("PTY manager output exceeded the probe limit".into());
                    }
                    output.extend_from_slice(&data);
                    if let Some(pid) =
                        pid_after_marker(&String::from_utf8_lossy(&output), "CODEZ_CHILD_PID:")
                    {
                        return Ok(pid);
                    }
                }
                Some(PtyEvent::Exit { id, .. }) if id == terminal_id => {
                    return Err("PTY manager exited before the descendant reported its PID".into());
                }
                Some(_) => {}
                None => return Err("PTY manager event channel closed unexpectedly".into()),
            }
        }
    })
    .await
    .map_err(|_| "timed out waiting for the descendant process ID")?
}

#[cfg(windows)]
fn powershell_executable() -> TestResult<PathBuf> {
    let system_root = std::env::var_os("SystemRoot").ok_or("SystemRoot is not configured")?;
    let executable = PathBuf::from(system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if !executable.is_file() {
        return Err(format!("PowerShell is missing at {}", executable.display()).into());
    }
    Ok(executable)
}

#[cfg(windows)]
fn command_prompt_executable() -> TestResult<PathBuf> {
    let system_root = std::env::var_os("SystemRoot").ok_or("SystemRoot is not configured")?;
    let executable = PathBuf::from(system_root).join("System32").join("cmd.exe");
    if !executable.is_file() {
        return Err(format!("command prompt is missing at {}", executable.display()).into());
    }
    Ok(executable)
}

#[cfg(windows)]
fn powershell_path_literal(path: &Path) -> TestResult<String> {
    let value = path
        .to_str()
        .ok_or("fixture executable path is not valid Unicode")?;
    Ok(format!("'{}'", value.replace('\'', "''")))
}

fn pid_after_marker(output: &str, marker: &str) -> Option<u32> {
    output.match_indices(marker).find_map(|(index, _)| {
        let digits = output[index + marker.len()..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>();
        (!digits.is_empty()).then(|| digits.parse().ok()).flatten()
    })
}

#[cfg(windows)]
struct TestDirectory(PathBuf);

#[cfg(windows)]
impl TestDirectory {
    fn create() -> TestResult<Self> {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let path =
            std::env::temp_dir().join(format!("codez-pty-中文-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&path)?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

#[cfg(windows)]
impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(windows)]
#[test]
fn windows_conpty_should_preserve_utf8_output() -> TestResult {
    let mut probe = spawn_shell(None)?;
    probe.write_line(
        "[Console]::WriteLine([string]::Concat('CODEZ_UTF8:', [char]0x4F60, [char]0x597D, [char]0xFF0C, 'CodeZ'))",
    )?;
    let output = probe.wait_for_output("CODEZ_UTF8:你好，CodeZ")?;
    let status = probe.exit_cleanly()?;
    let reader_closed = probe.finish()?;

    assert!(
        output.contains("CODEZ_UTF8:你好，CodeZ") && status.success() && reader_closed,
        "ConPTY did not preserve UTF-8 output and clean shutdown"
    );
    Ok(())
}

#[cfg(windows)]
#[test]
fn windows_conpty_should_open_a_chinese_working_directory() -> TestResult {
    let directory = TestDirectory::create()?;
    let expected = format!("CODEZ_CWD:{}", directory.path().display());
    let mut probe = spawn_shell(Some(directory.path()))?;
    probe.write_line(
        "[Console]::WriteLine([string]::Concat('CODEZ_', 'CWD:', (Get-Location).Path))",
    )?;
    let output = probe.wait_for_output(&expected)?;
    let status = probe.exit_cleanly()?;
    probe.finish()?;

    assert!(
        output.contains(&expected) && status.success(),
        "ConPTY did not preserve the configured Chinese working directory"
    );
    Ok(())
}

#[cfg(windows)]
#[test]
fn windows_conpty_should_report_resized_dimensions() -> TestResult {
    let mut probe = spawn_shell(None)?;
    probe.resize(RESIZED)?;
    probe.write_line(
        "$size = $Host.UI.RawUI.WindowSize; [Console]::WriteLine(('CODEZ_' + 'SIZE:' + $size.Width + 'x' + $size.Height))",
    )?;
    let output = probe.wait_for_output("CODEZ_SIZE:132x41")?;
    let reported_size = probe.reported_size()?;
    let status = probe.exit_cleanly()?;
    probe.finish()?;

    assert_eq!(
        (
            output.contains("CODEZ_SIZE:132x41"),
            reported_size,
            status.success()
        ),
        (true, RESIZED, true),
        "ConPTY resize was not visible to both the adapter and shell"
    );
    Ok(())
}

#[cfg(windows)]
#[test]
#[ignore = "spawned as a descendant by the ConPTY process-tree test"]
fn windows_process_tree_descendant_fixture() -> TestResult {
    let directory = std::env::current_dir()?;
    if !directory.join(PROCESS_TREE_FIXTURE_REQUEST).is_file() {
        return Ok(());
    }

    let lock_path = directory.join("child.lock");
    let ready_path = directory.join("child.ready");
    let _lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .share_mode(0)
        .open(lock_path)?;
    let pid = std::process::id();
    fs::write(&ready_path, format!("CODEZ_CHILD_READY:{pid}:END"))?;

    println!("CODEZ_CHILD_PID:{pid}");
    io::stdout().flush()?;
    loop {
        thread::sleep(Duration::from_secs(1));
    }
}

#[cfg(windows)]
#[test]
fn windows_conpty_should_deliver_ctrl_c_to_the_foreground_command() -> TestResult {
    let mut probe = PtyProbe::spawn(command_prompt(None))?;
    probe.write_line("echo CODEZ_CTRL_C_FIXTURE_READY & ping.exe -t 127.0.0.1")?;
    probe.wait_for_output("CODEZ_CTRL_C_FIXTURE_READY")?;
    probe.wait_for_value("ping output", |output| {
        (output.matches("127.0.0.1").count() >= 2).then_some(())
    })?;
    let prompt_count = String::from_utf8_lossy(&probe.output).matches('>').count();
    probe.write_ctrl_c()?;
    probe.wait_for_value("command prompt after Ctrl+C", |output| {
        (output.matches('>').count() > prompt_count).then_some(())
    })?;
    probe.write_line("echo CODEZ_AFTER_CTRL_C")?;
    let output = probe.wait_for_output("CODEZ_AFTER_CTRL_C")?;
    let status = probe.exit_cleanly()?;
    probe.finish()?;

    assert!(
        output.contains("CODEZ_AFTER_CTRL_C") && status.success(),
        "command shell did not resume after Ctrl+C"
    );
    Ok(())
}

#[cfg(windows)]
#[test]
fn windows_conpty_should_interrupt_two_powershell_foreground_commands() -> TestResult {
    let mut probe = PtyProbe::spawn(production_powershell(None))?;

    for attempt in 1..=2 {
        let ready = format!("CODEZ_POWERSHELL_CTRL_C_{attempt}_READY");
        let resumed = format!("CODEZ_POWERSHELL_CTRL_C_{attempt}_RESUMED");
        let prior_ping_output = String::from_utf8_lossy(&probe.output)
            .matches("127.0.0.1")
            .count();
        probe.write_line(&format!("Write-Output '{ready}'; ping.exe -t 127.0.0.1"))?;
        probe.wait_for_output(&ready)?;
        probe.wait_for_value("ping output", |output| {
            (output.matches("127.0.0.1").count() >= prior_ping_output + 3).then_some(())
        })?;
        let prompt_count = String::from_utf8_lossy(&probe.output)
            .matches("PS ")
            .count();
        probe.write_ctrl_c()?;
        probe.wait_for_value("PowerShell prompt after Ctrl+C", |output| {
            (output.matches("PS ").count() > prompt_count).then_some(())
        })?;
        probe.write_line(&format!("Write-Output '{resumed}'"))?;
        probe.wait_for_output(&resumed)?;
    }

    let status = probe.exit_cleanly()?;
    let reader_closed = probe.finish()?;

    assert!(
        status.success() && reader_closed,
        "PowerShell did not remain usable after repeated Ctrl+C interrupts"
    );
    Ok(())
}

#[cfg(windows)]
#[tokio::test]
async fn windows_manager_should_interrupt_ping_and_keep_the_shell_alive() -> TestResult {
    let arguments = [
        "-NoExit",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    assert_manager_repeated_ctrl_c(
        "ctrl-c-powershell-test",
        powershell_executable()?,
        arguments,
        "function prompt { 'CODEZ_PS_PROMPT> ' }",
        "CODEZ_PS_PROMPT>",
        ";",
    )
    .await
}

#[cfg(windows)]
#[tokio::test]
async fn windows_manager_should_interrupt_command_prompt_ping_twice() -> TestResult {
    assert_manager_repeated_ctrl_c(
        "ctrl-c-command-prompt-test",
        command_prompt_executable()?,
        ["/D", "/Q"].into_iter().map(Into::into).collect(),
        "prompt CODEZ_CMD_PROMPT$G",
        "CODEZ_CMD_PROMPT>",
        "&",
    )
    .await
}

#[cfg(windows)]
async fn assert_manager_repeated_ctrl_c(
    terminal_id: &str,
    executable: PathBuf,
    arguments: Vec<std::ffi::OsString>,
    prompt_setup: &str,
    prompt_marker: &str,
    command_separator: &str,
) -> TestResult {
    let current_directory = std::env::current_dir()?;
    let (event_tx, mut events) = tokio::sync::mpsc::channel(PTY_EVENT_QUEUE_CAPACITY);
    let manager = PtyManager::new(event_tx);
    manager
        .start(
            terminal_id.to_owned(),
            executable,
            arguments,
            current_directory,
        )
        .await?;
    wait_for_terminal_marker(&manager, &mut events, terminal_id, "\u{1b}[6n").await?;
    manager.write(terminal_id, b"\x1b[1;1R").await?;
    let prompt_setup = format!("{prompt_setup}\r");
    manager.write(terminal_id, prompt_setup.as_bytes()).await?;
    wait_for_terminal_marker(&manager, &mut events, terminal_id, prompt_marker).await?;

    for attempt in 1..=2 {
        let ready = format!("CODEZ_MANAGER_CTRL_C_{attempt}_READY");
        let resumed = format!("CODEZ_MANAGER_CTRL_C_{attempt}_RESUMED");
        let launch = format!("echo {ready} {command_separator} ping.exe -t 127.0.0.1\r");
        manager.write(terminal_id, launch.as_bytes()).await?;
        wait_for_terminal_marker(&manager, &mut events, terminal_id, &ready).await?;
        wait_for_terminal_marker(&manager, &mut events, terminal_id, "127.0.0.1").await?;
        manager.write(terminal_id, b"\x03").await?;

        // Console programs may flush pending input while handling Ctrl+C. The returned
        // prompt is the synchronization point before the next user command is entered.
        wait_for_terminal_marker(&manager, &mut events, terminal_id, prompt_marker).await?;
        let resume = format!("echo {resumed}\r");
        manager.write(terminal_id, resume.as_bytes()).await?;
        wait_for_terminal_marker(&manager, &mut events, terminal_id, &resumed).await?;
    }

    manager.kill(terminal_id).await?;

    assert_eq!(manager.active_count(), 0, "terminal was not fully reaped");
    Ok(())
}

#[cfg(windows)]
#[tokio::test]
async fn windows_ctrl_c_and_terminal_kill_should_not_deadlock() -> TestResult {
    const TERMINAL_ID: &str = "ctrl-c-kill-race-test";

    let current_directory = std::env::current_dir()?;
    let arguments = [
        "-NoExit",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    let (event_tx, mut events) = tokio::sync::mpsc::channel(PTY_EVENT_QUEUE_CAPACITY);
    let manager = PtyManager::new(event_tx);
    manager
        .start(
            TERMINAL_ID.to_owned(),
            powershell_executable()?,
            arguments,
            current_directory,
        )
        .await?;
    wait_for_terminal_marker(&manager, &mut events, TERMINAL_ID, "\u{1b}[6n").await?;
    manager.write(TERMINAL_ID, b"\x1b[1;1R").await?;
    manager
        .write(
            TERMINAL_ID,
            b"Write-Output 'CODEZ_RACE_READY'; ping.exe -t 127.0.0.1\r",
        )
        .await?;
    wait_for_terminal_marker(&manager, &mut events, TERMINAL_ID, "CODEZ_RACE_READY").await?;
    wait_for_terminal_marker(&manager, &mut events, TERMINAL_ID, "127.0.0.1").await?;

    let (write_result, kill_result) = tokio::join!(
        manager.write(TERMINAL_ID, b"\x03"),
        manager.kill(TERMINAL_ID)
    );
    if let Err(error) = write_result
        && error.kind() != codez_core::AppErrorKind::Conflict
    {
        return Err(format!("unexpected Ctrl+C race error: {error}").into());
    }
    kill_result?;

    assert_eq!(
        manager.active_count(),
        0,
        "terminal kill did not win the race"
    );
    Ok(())
}

#[cfg(windows)]
#[tokio::test]
async fn windows_supervisor_should_kill_the_shell_process_tree() -> TestResult {
    const TERMINAL_ID: &str = "process-tree-test";

    let directory = TestDirectory::create()?;
    let ready_path = directory.path().join("child.ready");
    let lock_path = directory.path().join("child.lock");
    fs::write(
        directory.path().join(PROCESS_TREE_FIXTURE_REQUEST),
        b"ready",
    )?;

    let fixture_executable = std::env::current_exe()?;
    let launch_command = format!(
        "& {} --ignored --exact windows_process_tree_descendant_fixture --nocapture\r\n",
        powershell_path_literal(&fixture_executable)?
    );
    let arguments = [
        "-NoLogo",
        "-NoProfile",
        "-NoExit",
        "-Command",
        "$u = [System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding = $u; [Console]::OutputEncoding = $u; $OutputEncoding = $u; if (Get-Module PSReadLine) { Remove-Module PSReadLine }",
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    let (event_tx, mut events) = tokio::sync::mpsc::channel(PTY_EVENT_QUEUE_CAPACITY);
    let manager = PtyManager::new(event_tx);
    manager
        .start(
            TERMINAL_ID.to_owned(),
            powershell_executable()?,
            arguments,
            directory.path().to_path_buf(),
        )
        .await?;
    if let Err(error) =
        wait_for_terminal_marker(&manager, &mut events, TERMINAL_ID, "\u{1b}[6n").await
    {
        let _ = manager.kill(TERMINAL_ID).await;
        return Err(error);
    }
    manager.write(TERMINAL_ID, b"\x1b[1;1R").await?;
    manager
        .write(TERMINAL_ID, launch_command.as_bytes())
        .await?;

    let child_pid = match wait_for_terminal_pid(&manager, &mut events, TERMINAL_ID).await {
        Ok(pid) => pid,
        Err(error) => {
            let _ = manager.kill(TERMINAL_ID).await;
            return Err(error);
        }
    };
    let ready_pid = wait_for_child_ready(&ready_path)?;
    let lock_was_held = exclusive_lock_is_held(&lock_path)?;

    manager.kill(TERMINAL_ID).await?;
    let lock_was_released = wait_for_exclusive_lock_release(&lock_path)?;

    assert_eq!(
        (
            ready_pid,
            lock_was_held,
            lock_was_released,
            manager.active_count(),
        ),
        (child_pid, true, true, 0),
        "tree termination did not stop the identified descendant and release its resources"
    );
    Ok(())
}

#[cfg(windows)]
#[test]
fn windows_conpty_should_close_the_reader_after_clean_exit() -> TestResult {
    let mut probe = spawn_shell(None)?;
    let status = probe.exit_cleanly()?;
    let reader_closed = probe.finish()?;

    assert_eq!(
        (status.success(), reader_closed),
        (true, true),
        "clean exit did not release the child and PTY reader"
    );
    Ok(())
}

#[cfg(not(windows))]
#[test]
fn unix_pty_should_resize_interrupt_and_exit_cleanly() -> TestResult {
    let mut probe = spawn_shell(None)?;
    probe.resize(RESIZED)?;
    probe.write_line(
        "read rows cols < <(stty size); printf 'CODEZ_UNIX_SIZE:%sx%s\\n' \"$cols\" \"$rows\"",
    )?;
    let resized = probe.wait_for_output("CODEZ_UNIX_SIZE:132x41")?;
    probe.write_line("printf 'CODEZ_UNIX_%s\\n' 'LOOP_STARTED'; sleep 120")?;
    probe.wait_for_output("CODEZ_UNIX_LOOP_STARTED")?;
    probe.write_bytes(&[0x03])?;
    probe.write_line("printf 'CODEZ_UNIX_%s\\n' 'AFTER_CTRL_C'")?;
    let interrupted = probe.wait_for_output("CODEZ_UNIX_AFTER_CTRL_C")?;
    let status = probe.exit_cleanly()?;
    probe.finish()?;

    assert_eq!(
        (
            resized.contains("CODEZ_UNIX_SIZE:132x41"),
            interrupted.contains("CODEZ_UNIX_AFTER_CTRL_C"),
            status.success(),
        ),
        (true, true, true),
        "Unix PTY smoke did not complete resize, Ctrl+C, and clean exit"
    );
    Ok(())
}
