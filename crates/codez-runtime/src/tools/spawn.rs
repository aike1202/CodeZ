use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use codez_core::CancellationToken;
use thiserror::Error;
use tokio::process::Command;

#[derive(Debug, Clone)]
pub struct SpawnResult {
    pub status: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

#[derive(Debug, Error)]
pub enum SpawnError {
    #[error("the shell executable must be an absolute file path")]
    InvalidExecutable,
    #[error("the command working directory must be an absolute directory")]
    InvalidWorkingDirectory,
    #[error("the command process could not be started")]
    Start(#[source] std::io::Error),
    #[error("the command process could not be observed")]
    Wait(#[source] std::io::Error),
    #[error("the command process was cancelled")]
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    Bash,
    PowerShell,
}

pub struct SpawnRunner;

impl SpawnRunner {
    pub async fn run(
        command: &str,
        cwd: &Path,
        shell: ShellKind,
        executable: &Path,
        timeout_ms: u64,
        cancellation: &CancellationToken,
    ) -> Result<SpawnResult, SpawnError> {
        if !executable.is_absolute() || !executable.is_file() {
            return Err(SpawnError::InvalidExecutable);
        }
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err(SpawnError::InvalidWorkingDirectory);
        }
        let mut process = Command::new(executable);
        match shell {
            ShellKind::PowerShell => {
                process
                    .arg("-NoProfile")
                    .arg("-NonInteractive")
                    .arg("-Command");
            }
            ShellKind::Bash => {
                process.arg("-c");
            }
        }
        process.arg(command);
        process.current_dir(cwd);
        process.stdout(Stdio::piped());
        process.stderr(Stdio::piped());
        process.kill_on_drop(true);
        let child = process.spawn().map_err(SpawnError::Start)?;
        let wait = child.wait_with_output();
        let output = tokio::select! {
            () = cancellation.cancelled() => return Err(SpawnError::Cancelled),
            result = tokio::time::timeout(Duration::from_millis(timeout_ms), wait) => result,
        };
        match output {
            Ok(Ok(output)) => Ok(SpawnResult {
                status: if output.status.success() {
                    "completed"
                } else {
                    "failed"
                }
                .to_string(),
                exit_code: output.status.code(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                timed_out: false,
            }),
            Ok(Err(error)) => Err(SpawnError::Wait(error)),
            Err(_) => Ok(SpawnResult {
                status: "timeout".to_string(),
                exit_code: None,
                stdout: String::new(),
                stderr: "Command execution timed out.".to_string(),
                timed_out: true,
            }),
        }
    }
}
