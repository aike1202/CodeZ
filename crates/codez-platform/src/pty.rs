use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;
use dashmap::DashMap;
use tokio::sync::mpsc;
use codez_core::AppError;

#[derive(Debug, Clone)]
pub enum PtyEvent {
    Output { id: String, data: Vec<u8> },
    Exit { id: String },
}

pub struct PtyManager {
    instances: DashMap<String, PtyInstance>,
    event_tx: mpsc::UnboundedSender<PtyEvent>,
}

struct PtyInstance {
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
}

impl PtyManager {
    pub fn new(event_tx: mpsc::UnboundedSender<PtyEvent>) -> Self {
        Self {
            instances: DashMap::new(),
            event_tx,
        }
    }

    pub fn start(&self, id: String, program: &str, args: &[&str], cwd: &str) -> Result<(), AppError> {
        if self.instances.contains_key(&id) {
            return Ok(());
        }

        let mut command = CommandBuilder::new(program);
        command.args(args);
        command.cwd(cwd);

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::external("Failed to open PTY", e.to_string(), false))?;

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::external("Failed to clone PTY reader", e.to_string(), false))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::external("Failed to take PTY writer", e.to_string(), false))?;

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| AppError::external("Failed to spawn PTY command", e.to_string(), false))?;

        drop(pair.slave);

        let instance = PtyInstance {
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            master: Mutex::new(pair.master),
        };

        self.instances.insert(id.clone(), instance);

        // Spawn reader thread
        let tx = self.event_tx.clone();
        let reader_id = id.clone();
        
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        break;
                    }
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        if tx.send(PtyEvent::Output { id: reader_id.clone(), data }).is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = tx.send(PtyEvent::Exit { id: reader_id });
        });

        Ok(())
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), AppError> {
        if let Some(instance) = self.instances.get(id) {
            let mut writer = instance.writer.lock().unwrap();
            writer.write_all(data).map_err(|e| {
                AppError::external("Failed to write to PTY", e.to_string(), false)
            })?;
            writer.flush().map_err(|e| {
                AppError::external("Failed to flush PTY", e.to_string(), false)
            })?;
        }
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), AppError> {
        if let Some(instance) = self.instances.get(id) {
            let master = instance.master.lock().unwrap();
            master
                .resize(PtySize {
                    cols,
                    rows,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| AppError::external("Failed to resize PTY", e.to_string(), false))?;
        }
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<(), AppError> {
        if let Some(instance) = self.instances.remove(id) {
            let mut child = instance.1.child.lock().unwrap();
            let _ = child.kill();
        }
        Ok(())
    }

    pub fn kill_all(&self) {
        for instance in self.instances.iter_mut() {
            let mut child = instance.child.lock().unwrap();
            let _ = child.kill();
        }
        self.instances.clear();
    }
}
