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
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

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

struct PtyProbe {
    master: Option<Box<dyn MasterPty + Send>>,
    child: Option<Box<dyn Child + Send + Sync>>,
    writer: Option<Box<dyn Write + Send>>,
    output: Vec<u8>,
    output_rx: Receiver<Vec<u8>>,
    reader_done_rx: Receiver<io::Result<()>>,
    reader_thread: Option<JoinHandle<()>>,
}

impl PtyProbe {
    fn spawn(command: CommandBuilder) -> TestResult<Self> {
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
        };

        #[cfg(windows)]
        {
            probe.wait_for_output("\u{1b}[6n")?;
            probe.write_bytes(b"\x1b[1;1R")?;
        }

        Ok(probe)
    }

    fn root_pid(&self) -> TestResult<u32> {
        self.child
            .as_ref()
            .and_then(|child| child.process_id())
            .ok_or_else(|| "PTY child did not expose a process ID".into())
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
        self.write_bytes(b"\r\n")?;
        #[cfg(not(windows))]
        self.write_bytes(b"\n")?;
        Ok(())
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
            "$u = [System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding = $u; [Console]::OutputEncoding = $u; $OutputEncoding = $u",
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
fn process_exists(pid: u32) -> bool {
    ProcessCommand::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .is_ok_and(|output| {
            String::from_utf8_lossy(&output.stdout).contains(&format!(",\"{pid}\","))
        })
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
    if output.status.success() || !process_exists(pid.parse()?) {
        return Ok(());
    }
    Err(format!(
        "taskkill failed: {}",
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
fn windows_conpty_should_deliver_ctrl_c_to_the_foreground_command() -> TestResult {
    let mut probe = spawn_shell(None)?;
    probe.write_line(
        "[Console]::WriteLine([string]::Concat('CODEZ_LOOP_', 'STARTED')); while ($true) { Start-Sleep -Milliseconds 100 }",
    )?;
    let before_interrupt = probe.wait_for_output("CODEZ_LOOP_STARTED")?;
    let prompt_count = before_interrupt.matches("PS ").count();
    probe.write_bytes(&[0x03])?;
    probe.wait_for_value("PowerShell prompt after Ctrl+C", |output| {
        (output.matches("PS ").count() > prompt_count).then_some(())
    })?;
    probe.write_line("[Console]::WriteLine([string]::Concat('CODEZ_AFTER_', 'CTRL_C'))")?;
    let output = probe.wait_for_output("CODEZ_AFTER_CTRL_C")?;
    let status = probe.exit_cleanly()?;
    probe.finish()?;

    assert!(
        output.contains("CODEZ_AFTER_CTRL_C") && status.success(),
        "PowerShell did not resume after Ctrl+C"
    );
    Ok(())
}

#[cfg(windows)]
#[test]
fn windows_supervisor_should_kill_the_shell_process_tree() -> TestResult {
    let mut probe = spawn_shell(None)?;
    let root_pid = probe.root_pid()?;
    probe.write_line(
        "$child = Start-Process powershell.exe -ArgumentList @('-NoLogo', '-NoProfile', '-Command', 'Start-Sleep -Seconds 120') -WindowStyle Hidden -PassThru; [Console]::WriteLine(([string]::Concat('CODEZ_CHILD_', 'PID:')) + $child.Id)",
    )?;
    let child_pid = probe.wait_for_value("child process ID", |output| {
        pid_after_marker(output, "CODEZ_CHILD_PID:")
    })?;
    if !process_exists(child_pid) {
        return Err(format!("fixture child process {child_pid} did not start").into());
    }

    kill_process_tree(root_pid)?;
    wait_for_process_exit(root_pid)?;
    wait_for_process_exit(child_pid)?;
    let _ = probe.wait_for_exit()?;
    probe.finish()?;

    assert!(
        !process_exists(root_pid) && !process_exists(child_pid),
        "tree termination left a PowerShell process running"
    );
    Ok(())
}

#[cfg(windows)]
#[test]
fn windows_conpty_should_close_the_reader_after_clean_exit() -> TestResult {
    let mut probe = spawn_shell(None)?;
    let root_pid = probe.root_pid()?;
    let status = probe.exit_cleanly()?;
    wait_for_process_exit(root_pid)?;
    let reader_closed = probe.finish()?;

    assert_eq!(
        (status.success(), process_exists(root_pid), reader_closed),
        (true, false, true),
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
