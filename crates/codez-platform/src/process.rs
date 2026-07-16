use std::process::Stdio;
use std::time::Instant;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use codez_core::{AppError, CancellationToken, PortFuture, ProcessOutput, ProcessRequest, ProcessRunner};

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Default)]
pub struct NativeProcessRunner;

impl NativeProcessRunner {
    pub fn new() -> Self {
        Self
    }
}

async fn read_limited(
    mut stream: impl AsyncReadExt + Unpin,
    max_bytes: usize,
    buf: &mut Vec<u8>,
) -> bool {
    let mut chunk = [0u8; 4096];
    let mut truncated = false;
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if buf.len() + n > max_bytes {
                    let allowed = max_bytes - buf.len();
                    buf.extend_from_slice(&chunk[..allowed]);
                    truncated = true;
                    // Note: We keep reading and discarding to prevent the child process from blocking
                    // if it writes a lot to this pipe.
                } else if !truncated {
                    buf.extend_from_slice(&chunk[..n]);
                }
            }
        }
    }
    truncated
}

impl ProcessRunner for NativeProcessRunner {
    fn run<'a>(
        &'a self,
        request: ProcessRequest,
        cancellation: CancellationToken,
    ) -> PortFuture<'a, ProcessOutput> {
        Box::pin(async move {
            request.validate()?;

            let mut cmd = Command::new(&request.program);
            cmd.args(&request.arguments);
            cmd.current_dir(&request.current_directory);
            
            cmd.env_clear();
            cmd.envs(&request.environment);

            cmd.stdout(Stdio::piped());
            cmd.stderr(Stdio::piped());
            cmd.kill_on_drop(true);
            
            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);

            let start = Instant::now();
            let mut child = cmd.spawn().map_err(|e| AppError::external(
                format!("Failed to spawn process {:?}", request.program),
                e.to_string(),
                false,
            ))?;

            let stdout = child.stdout.take().expect("stdout configured");
            let stderr = child.stderr.take().expect("stderr configured");

            let max_bytes = request.max_output_bytes as usize;
            
            // Shared reference or just pass a large enough max to each, 
            // the interface implies total combined output bytes?
            // "Combined memory bound applied to captured stdout and stderr."
            // Since they run concurrently, enforcing a strict combined bound perfectly is complex.
            // A simple approximation is allowing up to max_bytes for EACH, but capping final sum.
            let max_bytes = request.max_output_bytes as usize;
            
            let stdout_task = tokio::spawn(async move {
                let mut buf = Vec::new();
                let truncated = read_limited(stdout, max_bytes, &mut buf).await;
                (buf, truncated)
            });

            let stderr_task = tokio::spawn(async move {
                let mut buf = Vec::new();
                let truncated = read_limited(stderr, max_bytes, &mut buf).await;
                (buf, truncated)
            });

            let child_wait = child.wait();

            tokio::select! {
                _ = cancellation.cancelled() => {
                    Err(AppError::cancelled("Process cancelled by cancellation token"))
                    // child is dropped here, so process is killed
                }
                _ = tokio::time::sleep(request.timeout) => {
                    Err(AppError::timeout("Process execution timed out"))
                    // child is dropped here, so process is killed
                }
                status_res = child_wait => {
                    let status = status_res.map_err(|e| AppError::external(
                        "Process wait failed".to_string(),
                        e.to_string(),
                        false
                    ))?;
                    
                    let (stdout_res, stderr_res) = tokio::join!(stdout_task, stderr_task);
                    
                    let (stdout_data, stdout_trunc) = stdout_res.unwrap_or_default();
                    let (stderr_data, stderr_trunc) = stderr_res.unwrap_or_default();
                    
                    let mut combined_trunc = stdout_trunc || stderr_trunc;
                    
                    let mut final_out = stdout_data;
                    let mut final_err = stderr_data;
                    
                    if final_out.len() + final_err.len() > max_bytes {
                        combined_trunc = true;
                        if final_out.len() > max_bytes {
                            final_out.truncate(max_bytes);
                            final_err.clear();
                        } else {
                            let allowed_err = max_bytes - final_out.len();
                            final_err.truncate(allowed_err);
                        }
                    }

                    Ok(ProcessOutput {
                        exit_code: status.code(),
                        stdout: final_out,
                        stderr: final_err,
                        output_truncated: combined_trunc,
                        elapsed: start.elapsed(),
                    })
                }
            }
        })
    }
}
