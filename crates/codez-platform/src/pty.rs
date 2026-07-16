use std::{
    ffi::OsString,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
        mpsc as std_mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use codez_core::AppError;
use dashmap::DashMap;
#[cfg(unix)]
use nix::{
    errno::Errno,
    sys::signal::{Signal, killpg},
    unistd::Pid,
};
use portable_pty::{CommandBuilder, ExitStatus, MasterPty, PtySize, native_pty_system};
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot, watch};
#[cfg(windows)]
use win32job::{ExtendedLimitInfo, Job};

/// Maximum payload size of one terminal output frame.
pub const PTY_MAX_FRAME_BYTES: usize = 4 * 1024;
/// Bounded host queue capacity used by the desktop composition root.
pub const PTY_EVENT_QUEUE_CAPACITY: usize = 64;
/// Maximum number of frames sent to the host without a cumulative ACK.
pub const PTY_ACK_WINDOW: u64 = 4;
/// Maximum number of concurrently owned terminal processes.
pub const PTY_MAX_TERMINALS: usize = 16;

const PTY_COMMAND_QUEUE_CAPACITY: usize = 64;
const PTY_MAX_INPUT_BYTES: usize = 64 * 1024;
const PTY_MAX_ARGUMENTS: usize = 64;
const PTY_MAX_ARGUMENT_BYTES: usize = 64 * 1024;
const PTY_MAX_ID_BYTES: usize = 256;
const PTY_MAX_DIMENSION: u16 = 4_096;
const SUPERVISOR_POLL_INTERVAL: Duration = Duration::from_millis(20);
const SUPERVISOR_START_TIMEOUT: Duration = Duration::from_secs(10);
const TERMINAL_COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
const TERMINAL_CLOSE_TIMEOUT: Duration = Duration::from_secs(8);
const EXIT_EVENT_TIMEOUT: Duration = Duration::from_secs(1);
const PROCESS_TREE_EXIT_TIMEOUT: Duration = Duration::from_secs(5);

/// Ordered terminal event emitted by the registry's owned supervisor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    /// One raw byte frame. Frames for a terminal have monotonically increasing sequence numbers.
    Output {
        id: String,
        sequence: u64,
        data: Vec<u8>,
    },
    /// Stable terminal event emitted once after all owned handles and threads are reclaimed.
    Exit { id: String, exit_code: Option<u32> },
}

/// Registry and lifecycle owner for every active pseudo-terminal.
pub struct PtyManager {
    instances: DashMap<String, Arc<TerminalHandle>>,
    accepting: AtomicBool,
    admission: AsyncMutex<()>,
    event_tx: mpsc::Sender<PtyEvent>,
}

struct TerminalHandle {
    id: String,
    commands: std_mpsc::SyncSender<TerminalCommand>,
    stop_requested: AtomicBool,
    flow: Arc<OutputFlowControl>,
    completion: watch::Sender<Option<TerminalCompletion>>,
    supervisor: Mutex<Option<JoinHandle<()>>>,
}

enum TerminalCommand {
    Write {
        data: Vec<u8>,
        response: oneshot::Sender<CommandOutcome>,
    },
    Resize {
        size: PtySize,
        response: oneshot::Sender<CommandOutcome>,
    },
}

type CommandOutcome = Result<(), Arc<str>>;

#[derive(Debug, Clone)]
struct TerminalCompletion {
    failure: Option<Arc<str>>,
}

struct OutputFlowControl {
    state: Mutex<OutputFlowState>,
    changed: Condvar,
}

#[derive(Debug)]
struct OutputFlowState {
    next_sequence: u64,
    last_acked: u64,
    closing: bool,
}

struct SupervisorRequest {
    id: String,
    program: PathBuf,
    arguments: Vec<OsString>,
    current_directory: PathBuf,
    commands: std_mpsc::Receiver<TerminalCommand>,
    handle: Arc<TerminalHandle>,
    event_tx: mpsc::Sender<PtyEvent>,
}

struct InitializedTerminal {
    reader: Option<Box<dyn Read + Send>>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    tree: ProcessTreeOwner,
}

#[cfg(windows)]
struct ProcessTreeOwner {
    job: Job,
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy)]
struct ProcessTreeOwner {
    process_group: Pid,
}

impl PtyManager {
    /// Creates a terminal registry using a bounded host event sender.
    #[must_use]
    pub fn new(event_tx: mpsc::Sender<PtyEvent>) -> Self {
        Self {
            instances: DashMap::new(),
            accepting: AtomicBool::new(true),
            admission: AsyncMutex::new(()),
            event_tx,
        }
    }

    /// Starts one terminal or succeeds idempotently when the ID is already active.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] for invalid paths/limits, exhausted registry capacity,
    /// supervisor startup failures, or requests made after shutdown begins.
    pub async fn start(
        &self,
        id: String,
        program: PathBuf,
        arguments: Vec<OsString>,
        current_directory: PathBuf,
    ) -> Result<(), AppError> {
        validate_start_request(&id, &program, &arguments, &current_directory)?;
        let _admission = self.admission.lock().await;
        if !self.accepting.load(Ordering::Acquire) {
            return Err(AppError::conflict("The terminal registry is shutting down"));
        }

        if let Some(existing) = self.instances.get(&id).map(|entry| Arc::clone(&entry)) {
            if existing.completion_value().is_none() {
                return Ok(());
            }
            self.reap_handle(existing).await?;
        }
        if self.instances.len() >= PTY_MAX_TERMINALS {
            return Err(AppError::conflict(format!(
                "At most {PTY_MAX_TERMINALS} terminals may be active"
            )));
        }

        let (command_tx, command_rx) = std_mpsc::sync_channel(PTY_COMMAND_QUEUE_CAPACITY);
        let handle = Arc::new(TerminalHandle::new(id.clone(), command_tx));
        self.instances.insert(id.clone(), Arc::clone(&handle));

        let request = SupervisorRequest {
            id,
            program,
            arguments,
            current_directory,
            commands: command_rx,
            handle: Arc::clone(&handle),
            event_tx: self.event_tx.clone(),
        };
        let start_result = tokio::task::spawn_blocking(move || start_supervisor(request))
            .await
            .map_err(|source| {
                AppError::internal(format!("terminal supervisor startup task failed: {source}"))
            })?;

        if let Err(detail) = start_result {
            handle.request_stop();
            let _ = self.wait_for_completion(&handle).await;
            let _ = self.reap_handle(Arc::clone(&handle)).await;
            return Err(AppError::external(
                "The terminal process could not be started",
                detail.to_string(),
                false,
            ));
        }
        Ok(())
    }

    /// Writes one bounded input frame and waits for the terminal owner to apply it.
    pub async fn write(&self, id: &str, data: &[u8]) -> Result<(), AppError> {
        if data.len() > PTY_MAX_INPUT_BYTES {
            return Err(AppError::validation(format!(
                "Terminal input exceeds the {PTY_MAX_INPUT_BYTES}-byte limit"
            )));
        }
        let handle = self.handle(id)?;
        let (response, receiver) = oneshot::channel();
        send_terminal_command(
            &handle,
            TerminalCommand::Write {
                data: data.to_vec(),
                response,
            },
        )?;
        await_command(receiver, "write").await
    }

    /// Resizes an active terminal and waits for the owner to apply the dimensions.
    pub async fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), AppError> {
        validate_dimensions(cols, rows)?;
        let handle = self.handle(id)?;
        let (response, receiver) = oneshot::channel();
        send_terminal_command(
            &handle,
            TerminalCommand::Resize {
                size: PtySize {
                    cols,
                    rows,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                response,
            },
        )?;
        await_command(receiver, "resize").await
    }

    /// Advances one terminal's cumulative output acknowledgement.
    pub fn acknowledge(&self, id: &str, sequence: u64) -> Result<(), AppError> {
        let Some(handle) = self.instances.get(id).map(|entry| Arc::clone(&entry)) else {
            return Ok(());
        };
        handle.flow.acknowledge(sequence)
    }

    /// Stops a terminal, waits for process-tree and reader cleanup, and is idempotent.
    pub async fn kill(&self, id: &str) -> Result<(), AppError> {
        let Some(handle) = self.instances.get(id).map(|entry| Arc::clone(&entry)) else {
            return Ok(());
        };
        handle.request_stop();
        let completion = self.wait_for_completion(&handle).await;
        let joined = self.reap_handle(handle).await;
        completion.and(joined)
    }

    /// Prevents any later terminal starts.
    pub fn stop_accepting(&self) {
        self.accepting.store(false, Ordering::Release);
    }

    /// Stops every terminal concurrently and waits for every owned supervisor thread.
    pub async fn kill_all(&self) -> Result<(), AppError> {
        self.request_stop_all();
        let handles = self
            .instances
            .iter()
            .map(|entry| Arc::clone(entry.value()))
            .collect::<Vec<_>>();

        let mut first_error = None;
        for handle in handles {
            if let Err(error) = self.wait_for_completion(&handle).await
                && first_error.is_none()
            {
                first_error = Some(error);
            }
            if let Err(error) = self.reap_handle(handle).await
                && first_error.is_none()
            {
                first_error = Some(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    /// Requests cooperative closure for all terminals without waiting.
    pub fn request_stop_all(&self) {
        for handle in &self.instances {
            handle.value().request_stop();
        }
    }

    /// Stops admission and fully reclaims every terminal owned by this registry.
    pub async fn shutdown(&self) -> Result<(), AppError> {
        self.stop_accepting();
        self.kill_all().await
    }

    /// Returns the number of terminal IDs currently retained by the registry.
    #[must_use]
    pub fn active_count(&self) -> usize {
        self.instances.len()
    }

    fn handle(&self, id: &str) -> Result<Arc<TerminalHandle>, AppError> {
        self.instances
            .get(id)
            .map(|entry| Arc::clone(&entry))
            .ok_or_else(|| AppError::not_found("The terminal is not active"))
    }

    async fn wait_for_completion(&self, handle: &TerminalHandle) -> Result<(), AppError> {
        let mut completion = handle.completion.subscribe();
        let outcome = tokio::time::timeout(TERMINAL_CLOSE_TIMEOUT, async {
            loop {
                if let Some(value) = completion.borrow().clone() {
                    return Ok::<TerminalCompletion, AppError>(value);
                }
                completion.changed().await.map_err(|_| {
                    AppError::internal("terminal completion owner closed unexpectedly")
                })?;
            }
        })
        .await
        .map_err(|_| AppError::timeout("The terminal did not close before its deadline"))??;

        outcome.failure.map_or(Ok(()), |detail| {
            Err(AppError::external(
                "The terminal closed with a platform failure",
                detail.to_string(),
                false,
            ))
        })
    }

    async fn reap_handle(&self, handle: Arc<TerminalHandle>) -> Result<(), AppError> {
        let id = handle.id.clone();
        let join_owner = Arc::clone(&handle);
        let join_result = tokio::task::spawn_blocking(move || join_owner.join_supervisor())
            .await
            .map_err(|source| {
                AppError::internal(format!("terminal supervisor join task failed: {source}"))
            })?;
        self.instances
            .remove_if(&id, |_, current| Arc::ptr_eq(current, &handle));
        join_result
    }
}

impl Drop for PtyManager {
    fn drop(&mut self) {
        self.accepting.store(false, Ordering::Release);
        for instance in &self.instances {
            instance.value().request_stop();
        }
    }
}

impl TerminalHandle {
    fn new(id: String, commands: std_mpsc::SyncSender<TerminalCommand>) -> Self {
        let (completion, _initial_receiver) = watch::channel(None);
        Self {
            id,
            commands,
            stop_requested: AtomicBool::new(false),
            flow: Arc::new(OutputFlowControl::new()),
            completion,
            supervisor: Mutex::new(None),
        }
    }

    fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::Release);
        self.flow.close();
    }

    fn completion_value(&self) -> Option<TerminalCompletion> {
        self.completion.borrow().clone()
    }

    fn complete(&self, failure: Option<Arc<str>>) {
        self.flow.close();
        self.completion
            .send_replace(Some(TerminalCompletion { failure }));
    }

    fn set_supervisor(&self, supervisor: JoinHandle<()>) {
        let mut owner = self
            .supervisor
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        *owner = Some(supervisor);
    }

    fn join_supervisor(&self) -> Result<(), AppError> {
        let supervisor = self
            .supervisor
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(supervisor) = supervisor {
            supervisor.join().map_err(|_| {
                AppError::internal("terminal supervisor thread panicked during cleanup")
            })?;
        }
        Ok(())
    }
}

impl OutputFlowControl {
    fn new() -> Self {
        Self {
            state: Mutex::new(OutputFlowState {
                next_sequence: 1,
                last_acked: 0,
                closing: false,
            }),
            changed: Condvar::new(),
        }
    }

    fn reserve_sequence(&self) -> Result<Option<u64>, Arc<str>> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        while !state.closing
            && state.next_sequence.saturating_sub(state.last_acked) > PTY_ACK_WINDOW
        {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
        if state.closing {
            return Ok(None);
        }
        let sequence = state.next_sequence;
        state.next_sequence = state.next_sequence.checked_add(1).ok_or_else(|| {
            Arc::<str>::from("terminal output sequence exhausted its integer range")
        })?;
        Ok(Some(sequence))
    }

    fn acknowledge(&self, sequence: u64) -> Result<(), AppError> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let last_sent = state.next_sequence.saturating_sub(1);
        if sequence > last_sent {
            return Err(AppError::validation(
                "Terminal output acknowledgement is ahead of the sent sequence",
            ));
        }
        if sequence > state.last_acked {
            state.last_acked = sequence;
            self.changed.notify_all();
        }
        Ok(())
    }

    fn close(&self) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.closing = true;
        self.changed.notify_all();
    }

    fn is_closing(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .closing
    }
}

fn validate_start_request(
    id: &str,
    program: &Path,
    arguments: &[OsString],
    current_directory: &Path,
) -> Result<(), AppError> {
    if id.is_empty()
        || id.len() > PTY_MAX_ID_BYTES
        || id.chars().any(|character| character.is_control())
    {
        return Err(AppError::validation("The terminal ID is invalid"));
    }
    if !program.is_absolute() {
        return Err(AppError::validation(
            "The terminal executable path must be absolute",
        ));
    }
    if !current_directory.is_absolute() {
        return Err(AppError::validation(
            "The terminal working directory must be absolute",
        ));
    }
    if arguments.len() > PTY_MAX_ARGUMENTS
        || arguments
            .iter()
            .map(|argument| argument.len())
            .sum::<usize>()
            > PTY_MAX_ARGUMENT_BYTES
    {
        return Err(AppError::validation(
            "The terminal argument list is too large",
        ));
    }
    Ok(())
}

fn validate_dimensions(cols: u16, rows: u16) -> Result<(), AppError> {
    if cols == 0 || rows == 0 || cols > PTY_MAX_DIMENSION || rows > PTY_MAX_DIMENSION {
        return Err(AppError::validation(format!(
            "Terminal dimensions must be between 1 and {PTY_MAX_DIMENSION}"
        )));
    }
    Ok(())
}

fn send_terminal_command(
    handle: &TerminalHandle,
    command: TerminalCommand,
) -> Result<(), AppError> {
    if handle.stop_requested.load(Ordering::Acquire) {
        return Err(AppError::conflict("The terminal is closing"));
    }
    handle
        .commands
        .try_send(command)
        .map_err(|source| match source {
            std_mpsc::TrySendError::Full(_) => {
                AppError::conflict("The terminal command queue is full")
            }
            std_mpsc::TrySendError::Disconnected(_) => {
                AppError::conflict("The terminal supervisor is no longer available")
            }
        })
}

async fn await_command(
    receiver: oneshot::Receiver<CommandOutcome>,
    operation: &'static str,
) -> Result<(), AppError> {
    tokio::time::timeout(TERMINAL_COMMAND_TIMEOUT, receiver)
        .await
        .map_err(|_| AppError::timeout(format!("The terminal {operation} command timed out")))?
        .map_err(|_| AppError::conflict("The terminal closed before applying the command"))?
        .map_err(|detail| {
            AppError::external(
                format!("The terminal {operation} command failed"),
                detail.to_string(),
                false,
            )
        })
}

fn start_supervisor(request: SupervisorRequest) -> Result<(), Arc<str>> {
    let id = request.id.clone();
    let handle = Arc::clone(&request.handle);
    let (start_tx, start_rx) = std_mpsc::sync_channel(0);
    let (ready_tx, ready_rx) = std_mpsc::sync_channel(0);
    let supervisor = thread::Builder::new()
        .name(format!("codez-pty-{id}"))
        .spawn(move || {
            if start_rx.recv().is_ok() {
                terminal_supervisor(request, ready_tx);
            }
        })
        .map_err(|source| Arc::<str>::from(format!("spawn supervisor thread: {source}")))?;
    handle.set_supervisor(supervisor);
    start_tx
        .send(())
        .map_err(|_| Arc::<str>::from("terminal supervisor stopped before initialization"))?;
    ready_rx
        .recv_timeout(SUPERVISOR_START_TIMEOUT)
        .map_err(|source| Arc::<str>::from(format!("wait for terminal initialization: {source}")))?
}

fn terminal_supervisor(
    request: SupervisorRequest,
    ready: std_mpsc::SyncSender<Result<(), Arc<str>>>,
) {
    let initialized = initialize_terminal(&request);
    let mut terminal = match initialized {
        Ok(terminal) => terminal,
        Err(detail) => {
            let _ = ready.send(Err(Arc::clone(&detail)));
            request.handle.complete(Some(detail));
            return;
        }
    };

    let (reader_done_tx, reader_done_rx) = std_mpsc::sync_channel(1);
    let reader_id = request.id.clone();
    let reader_flow = Arc::clone(&request.handle.flow);
    let reader_events = request.event_tx.clone();
    let Some(reader) = terminal.reader.take() else {
        let detail = Arc::<str>::from("terminal reader owner was already taken");
        let _ = ready.send(Err(Arc::clone(&detail)));
        request.handle.complete(Some(detail));
        return;
    };
    let reader_thread = match thread::Builder::new()
        .name(format!("codez-pty-reader-{}", request.id))
        .spawn(move || {
            let result = read_terminal_output(reader, &reader_id, &reader_flow, &reader_events);
            let _ = reader_done_tx.send(result);
        }) {
        Ok(reader_thread) => reader_thread,
        Err(source) => {
            let detail = Arc::<str>::from(format!("spawn terminal reader thread: {source}"));
            let failure = close_initialized_terminal(
                terminal,
                None,
                None,
                None,
                Some(reader_done_rx),
                Some(Arc::clone(&detail)),
                &request,
            );
            let _ = ready.send(Err(Arc::clone(&detail)));
            request.handle.complete(failure.or(Some(detail)));
            return;
        }
    };

    let _ = ready.send(Ok(()));
    let mut exit_status = None;
    let mut reader_result = None;
    let mut failure = None;

    loop {
        if request.handle.stop_requested.load(Ordering::Acquire) {
            break;
        }
        match terminal.child.try_wait() {
            Ok(Some(status)) => {
                exit_status = Some(status);
                break;
            }
            Ok(None) => {}
            Err(source) => {
                failure = Some(Arc::<str>::from(format!(
                    "poll terminal child status: {source}"
                )));
                break;
            }
        }
        match reader_done_rx.try_recv() {
            Ok(result) => {
                if let Err(detail) = &result {
                    failure = Some(Arc::clone(detail));
                    request.handle.request_stop();
                }
                reader_result = Some(result);
                if failure.is_some() {
                    break;
                }
            }
            Err(std_mpsc::TryRecvError::Empty) => {}
            Err(std_mpsc::TryRecvError::Disconnected) => {
                failure = Some(Arc::<str>::from(
                    "terminal reader completion channel disconnected",
                ));
                break;
            }
        }

        match request.commands.recv_timeout(SUPERVISOR_POLL_INTERVAL) {
            Ok(command) => {
                if let Err(detail) = apply_terminal_command(command, &mut terminal) {
                    failure = Some(detail);
                    request.handle.request_stop();
                    break;
                }
            }
            Err(std_mpsc::RecvTimeoutError::Timeout) => {}
            Err(std_mpsc::RecvTimeoutError::Disconnected) => {
                request.handle.request_stop();
                break;
            }
        }
    }

    let close_failure = close_initialized_terminal(
        terminal,
        exit_status,
        Some(reader_thread),
        reader_result,
        Some(reader_done_rx),
        failure,
        &request,
    );
    request.handle.complete(close_failure);
}

fn initialize_terminal(request: &SupervisorRequest) -> Result<InitializedTerminal, Arc<str>> {
    let mut command = CommandBuilder::new(&request.program);
    command.args(&request.arguments);
    command.cwd(&request.current_directory);

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|source| Arc::<str>::from(format!("open native PTY: {source}")))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|source| Arc::<str>::from(format!("clone PTY reader: {source}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|source| Arc::<str>::from(format!("take PTY writer: {source}")))?;

    #[cfg(windows)]
    let job = create_windows_job()?;
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|source| Arc::<str>::from(format!("spawn PTY child: {source}")))?;
    drop(pair.slave);

    #[cfg(windows)]
    let tree = match assign_windows_job(job, &*child) {
        Ok(tree) => tree,
        Err(detail) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(detail);
        }
    };
    #[cfg(unix)]
    let tree = match unix_process_tree(&*child, &*pair.master) {
        Ok(tree) => tree,
        Err(detail) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(detail);
        }
    };

    Ok(InitializedTerminal {
        reader: Some(reader),
        writer,
        child,
        master: pair.master,
        tree,
    })
}

fn apply_terminal_command(
    command: TerminalCommand,
    terminal: &mut InitializedTerminal,
) -> Result<(), Arc<str>> {
    match command {
        TerminalCommand::Write { data, response } => {
            let result = terminal
                .writer
                .write_all(&data)
                .and_then(|()| terminal.writer.flush())
                .map_err(|source| Arc::<str>::from(format!("write PTY input: {source}")));
            let failure = result.as_ref().err().cloned();
            let _ = response.send(result);
            failure.map_or(Ok(()), Err)
        }
        TerminalCommand::Resize { size, response } => {
            let result = terminal
                .master
                .resize(size)
                .map_err(|source| Arc::<str>::from(format!("resize PTY: {source}")));
            let failure = result.as_ref().err().cloned();
            let _ = response.send(result);
            failure.map_or(Ok(()), Err)
        }
    }
}

fn read_terminal_output(
    mut reader: Box<dyn Read + Send>,
    id: &str,
    flow: &OutputFlowControl,
    event_tx: &mpsc::Sender<PtyEvent>,
) -> Result<(), Arc<str>> {
    let mut frame = [0_u8; PTY_MAX_FRAME_BYTES];
    loop {
        let read = reader
            .read(&mut frame)
            .map_err(|source| Arc::<str>::from(format!("read PTY output: {source}")))?;
        if read == 0 {
            return Ok(());
        }
        let Some(sequence) = flow.reserve_sequence()? else {
            return Ok(());
        };
        let event = PtyEvent::Output {
            id: id.to_string(),
            sequence,
            data: frame[..read].to_vec(),
        };
        if !send_output_event(event_tx, flow, event)? {
            return Ok(());
        }
    }
}

fn send_output_event(
    event_tx: &mpsc::Sender<PtyEvent>,
    flow: &OutputFlowControl,
    mut event: PtyEvent,
) -> Result<bool, Arc<str>> {
    loop {
        if flow.is_closing() {
            return Ok(false);
        }
        match event_tx.try_send(event) {
            Ok(()) => return Ok(true),
            Err(mpsc::error::TrySendError::Full(returned)) => {
                event = returned;
                thread::sleep(SUPERVISOR_POLL_INTERVAL);
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                return Err(Arc::<str>::from("terminal event receiver is closed"));
            }
        }
    }
}

fn close_initialized_terminal(
    terminal: InitializedTerminal,
    known_exit_status: Option<ExitStatus>,
    reader_thread: Option<JoinHandle<()>>,
    mut reader_result: Option<Result<(), Arc<str>>>,
    reader_done: Option<std_mpsc::Receiver<Result<(), Arc<str>>>>,
    initial_failure: Option<Arc<str>>,
    request: &SupervisorRequest,
) -> Option<Arc<str>> {
    request.handle.flow.close();
    let InitializedTerminal {
        reader,
        writer,
        mut child,
        master,
        tree,
    } = terminal;
    drop(writer);

    let tree_result = terminate_process_tree(tree, &mut *child, known_exit_status);
    let exit_code = tree_result.as_ref().ok().map(ExitStatus::exit_code);
    drop(child);
    drop(master);
    drop(reader);

    let joined = reader_thread.map(|reader_thread| {
        reader_thread
            .join()
            .map_err(|_| Arc::<str>::from("terminal reader thread panicked"))
    });
    if reader_result.is_none() {
        reader_result = reader_done.and_then(|reader_done| reader_done.try_recv().ok());
    }
    let reader_failure = reader_result
        .and_then(Result::err)
        .or_else(|| joined.and_then(Result::err));
    let tree_failure = tree_result.err();
    let exit_failure = send_exit_event(
        &request.event_tx,
        PtyEvent::Exit {
            id: request.id.clone(),
            exit_code,
        },
    )
    .err();

    initial_failure
        .or(reader_failure)
        .or(tree_failure)
        .or(exit_failure)
}

fn send_exit_event(event_tx: &mpsc::Sender<PtyEvent>, mut event: PtyEvent) -> Result<(), Arc<str>> {
    let deadline = Instant::now() + EXIT_EVENT_TIMEOUT;
    loop {
        match event_tx.try_send(event) {
            Ok(()) => return Ok(()),
            Err(mpsc::error::TrySendError::Full(returned)) => {
                if Instant::now() >= deadline {
                    return Err(Arc::<str>::from("terminal exit event queue remained full"));
                }
                event = returned;
                thread::sleep(SUPERVISOR_POLL_INTERVAL);
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                return Err(Arc::<str>::from("terminal event receiver is closed"));
            }
        }
    }
}

#[cfg(windows)]
fn create_windows_job() -> Result<Job, Arc<str>> {
    let mut limits = ExtendedLimitInfo::new();
    limits.limit_kill_on_job_close();
    Job::create_with_limit_info(&limits)
        .map_err(|source| Arc::<str>::from(format!("create terminal Job Object: {source}")))
}

#[cfg(windows)]
fn assign_windows_job(
    job: Job,
    child: &dyn portable_pty::Child,
) -> Result<ProcessTreeOwner, Arc<str>> {
    let handle = child
        .as_raw_handle()
        .ok_or_else(|| Arc::<str>::from("PTY child did not expose a process handle"))?;
    job.assign_process(handle as isize)
        .map_err(|source| Arc::<str>::from(format!("assign PTY child to Job Object: {source}")))?;
    Ok(ProcessTreeOwner { job })
}

#[cfg(unix)]
fn unix_process_tree(
    child: &dyn portable_pty::Child,
    master: &dyn MasterPty,
) -> Result<ProcessTreeOwner, Arc<str>> {
    let process_id = child
        .process_id()
        .ok_or_else(|| Arc::<str>::from("PTY child did not expose a process ID"))?;
    let process_id = i32::try_from(process_id)
        .map_err(|_| Arc::<str>::from("PTY child process ID exceeded i32"))?;
    let process_group = master
        .process_group_leader()
        .ok_or_else(|| Arc::<str>::from("PTY did not expose its process group leader"))?;
    if process_group != process_id {
        return Err(Arc::<str>::from(
            "PTY process group leader did not match the spawned child",
        ));
    }
    Ok(ProcessTreeOwner {
        process_group: Pid::from_raw(process_group),
    })
}

#[cfg(windows)]
fn terminate_process_tree(
    tree: ProcessTreeOwner,
    child: &mut dyn portable_pty::Child,
    known_exit_status: Option<ExitStatus>,
) -> Result<ExitStatus, Arc<str>> {
    drop(tree.job);
    known_exit_status.map_or_else(|| wait_for_child_exit(child), Ok)
}

#[cfg(unix)]
fn terminate_process_tree(
    tree: ProcessTreeOwner,
    child: &mut dyn portable_pty::Child,
    known_exit_status: Option<ExitStatus>,
) -> Result<ExitStatus, Arc<str>> {
    if let Err(source) = killpg(tree.process_group, Signal::SIGKILL)
        && source != Errno::ESRCH
    {
        return Err(Arc::<str>::from(format!(
            "terminate PTY process group: {source}"
        )));
    }
    let status = known_exit_status.map_or_else(|| wait_for_child_exit(child), Ok)?;
    let deadline = Instant::now() + PROCESS_TREE_EXIT_TIMEOUT;
    loop {
        match killpg(tree.process_group, None) {
            Err(Errno::ESRCH) => return Ok(status),
            Ok(()) | Err(Errno::EPERM) => {
                if Instant::now() >= deadline {
                    return Err(Arc::<str>::from(
                        "PTY process group remained alive after termination",
                    ));
                }
                thread::sleep(SUPERVISOR_POLL_INTERVAL);
            }
            Err(source) => {
                return Err(Arc::<str>::from(format!(
                    "verify PTY process group exit: {source}"
                )));
            }
        }
    }
}

fn wait_for_child_exit(child: &mut dyn portable_pty::Child) -> Result<ExitStatus, Arc<str>> {
    let deadline = Instant::now() + PROCESS_TREE_EXIT_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    return Err(Arc::<str>::from(
                        "PTY child did not exit after process-tree termination",
                    ));
                }
                thread::sleep(SUPERVISOR_POLL_INTERVAL);
            }
            Err(source) => {
                return Err(Arc::<str>::from(format!(
                    "wait for PTY child exit: {source}"
                )));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        sync::{Arc, mpsc},
        thread,
        time::Duration,
    };

    use codez_core::AppErrorKind;
    use tokio::sync::mpsc as tokio_mpsc;

    use super::{OutputFlowControl, PTY_ACK_WINDOW, PTY_EVENT_QUEUE_CAPACITY, PtyManager};

    #[test]
    fn output_flow_should_block_after_the_ack_window() {
        let flow = Arc::new(OutputFlowControl::new());
        for expected in 1..=PTY_ACK_WINDOW {
            assert_eq!(
                flow.reserve_sequence()
                    .expect("sequence reservation must succeed"),
                Some(expected)
            );
        }
        let blocked_flow = Arc::clone(&flow);
        let (sent, received) = mpsc::sync_channel(1);
        let producer = thread::spawn(move || {
            let sequence = blocked_flow.reserve_sequence();
            let _ = sent.send(sequence);
        });

        assert!(received.recv_timeout(Duration::from_millis(100)).is_err());
        flow.acknowledge(1)
            .expect("cumulative ACK must release one frame");
        assert_eq!(
            received
                .recv_timeout(Duration::from_secs(1))
                .expect("fifth frame must resume after ACK")
                .expect("sequence reservation must succeed"),
            Some(PTY_ACK_WINDOW + 1)
        );
        producer.join().expect("flow-control producer must join");
    }

    #[test]
    fn output_flow_should_reject_future_acknowledgements() {
        let flow = OutputFlowControl::new();

        let error = flow
            .acknowledge(1)
            .expect_err("ACK ahead of output must fail");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[tokio::test]
    async fn terminal_kill_should_be_idempotent_for_unknown_ids() {
        let (events, _receiver) = tokio_mpsc::channel(PTY_EVENT_QUEUE_CAPACITY);
        let manager = PtyManager::new(events);

        manager
            .kill("not-running")
            .await
            .expect("first absent kill must succeed");
        manager
            .kill("not-running")
            .await
            .expect("repeated absent kill must succeed");

        assert_eq!(manager.active_count(), 0);
    }

    #[tokio::test]
    async fn terminal_start_should_reject_relative_process_paths() {
        let (events, _receiver) = tokio_mpsc::channel(PTY_EVENT_QUEUE_CAPACITY);
        let manager = PtyManager::new(events);
        let current_directory =
            std::env::current_dir().expect("test working directory must be available");

        let error = manager
            .start(
                "terminal-1".to_string(),
                PathBuf::from("powershell.exe"),
                Vec::new(),
                current_directory,
            )
            .await
            .expect_err("relative executable path must fail");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }
}
