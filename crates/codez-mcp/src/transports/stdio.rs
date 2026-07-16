use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};

pub struct StdioTransport {
    child: Child,
    stdin: Child_Stdin_Type_Wrapper,
}

struct Child_Stdin_Type_Wrapper {
    inner: ChildStdin,
}

impl StdioTransport {
    pub fn new(command: &str, args: &[String]) -> Result<Self, String> {
        let mut cmd = Command::new(command);
        cmd.args(args);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::null());

        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let stdin = child.stdin.take().ok_or_else(|| "Failed to open stdin".to_string())?;

        Ok(Self {
            child,
            stdin: Child_Stdin_Type_Wrapper { inner: stdin },
        })
    }

    pub async fn send_raw(&mut self, data: &str) -> Result<(), String> {
        let payload = format!("{}\n", data);
        self.stdin.inner.write_all(payload.as_bytes()).await.map_err(|e| e.to_string())?;
        self.stdin.inner.flush().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn shutdown(&mut self) {
        let _ = self.child.kill().await;
    }
}
