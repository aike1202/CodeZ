use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Debug, Clone)]
pub struct SpawnResult {
    pub status: String, // "completed" | "failed" | "timeout"
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

pub struct SpawnRunner;

impl SpawnRunner {
    pub async fn run(
        cmd_str: &str,
        cwd: &str,
        shell: &str,
        executable: Option<&str>,
        timeout_ms: u64,
    ) -> Result<SpawnResult, String> {
        let mut cmd = if shell == "powershell" {
            let exe = executable.unwrap_or("powershell");
            let mut c = Command::new(exe);
            c.arg("-Command").arg(cmd_str);
            c
        } else {
            let exe = executable.unwrap_or("bash");
            let mut c = Command::new(exe);
            c.arg("-c").arg(cmd_str);
            c
        };

        cmd.current_dir(cwd);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.kill_on_drop(true); // Automatically kills child process if the future is dropped (e.g. on timeout)

        let child = cmd.spawn().map_err(|e| e.to_string())?;

        let run_future = child.wait_with_output();
        
        match timeout(Duration::from_millis(timeout_ms), run_future).await {
            Ok(Ok(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                let code = output.status.code();
                Ok(SpawnResult {
                    status: if output.status.success() { "completed".to_string() } else { "failed".to_string() },
                    exit_code: code,
                    stdout,
                    stderr,
                    timed_out: false,
                })
            }
            Ok(Err(e)) => {
                Err(e.to_string())
            }
            Err(_) => {
                Ok(SpawnResult {
                    status: "timeout".to_string(),
                    exit_code: None,
                    stdout: String::new(),
                    stderr: "Command execution timed out.".to_string(),
                    timed_out: true,
                })
            }
        }
    }
}
