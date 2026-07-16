use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::fs::{self, File};
use tokio::io::{AsyncWriteExt, AsyncBufReadExt, BufReader};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use codez_contracts::context::{
    LedgerEvent, LedgerEventType, SessionRuntimeSnapshot,
    SessionRuntimeScopeSnapshot, NormalizedModelMessage,
};

#[derive(Debug, thiserror::Error)]
pub enum LedgerError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Parse error: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("Lock error: {0}")]
    Lock(String),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LoadedSessionRuntime {
    #[serde(flatten)]
    pub snapshot: SessionRuntimeSnapshot,
    pub warnings: Vec<String>,
}

pub struct ModelLedgerStore {
    pub runtime_root: PathBuf,
    cache: Arc<RwLock<HashMap<String, LoadedSessionRuntime>>>,
}

impl ModelLedgerStore {
    pub fn new<P: AsRef<Path>>(runtime_root: P) -> Self {
        Self {
            runtime_root: runtime_root.as_ref().to_path_buf(),
            cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn session_directory(&self, session_id: &str) -> PathBuf {
        self.runtime_root.join(session_id)
    }

    pub fn ledger_path(&self, session_id: &str) -> PathBuf {
        self.session_directory(session_id).join("ledger.jsonl")
    }

    pub fn snapshot_path(&self, session_id: &str) -> PathBuf {
        self.session_directory(session_id).join("snapshot.json")
    }

    pub fn lock_path(&self, session_id: &str) -> PathBuf {
        self.session_directory(session_id).join(".writer.lock")
    }

    pub async fn check_lock(&self, session_id: &str) -> Result<bool, LedgerError> {
        let lock_file = self.lock_path(session_id);
        if !lock_file.exists() {
            return Ok(true);
        }
        let pid_str = fs::read_to_string(&lock_file).await?;
        if let Ok(pid) = pid_str.trim().parse::<u32>() {
            let current_pid = std::process::id();
            if pid == current_pid {
                return Ok(true);
            }
            // In Windows, process liveness check can be tricky. We just assume it's locked if different pid for now,
            // or we could use `sysinfo`. To keep it simple:
            return Err(LedgerError::Lock(format!("Locked by PID {}", pid)));
        }
        Ok(true)
    }

    pub async fn acquire_lock(&self, session_id: &str) -> Result<(), LedgerError> {
        self.check_lock(session_id).await?;
        let lock_file = self.lock_path(session_id);
        let pid = std::process::id();
        fs::write(&lock_file, pid.to_string()).await?;
        Ok(())
    }

    pub async fn release_lock(&self, session_id: &str) -> Result<(), LedgerError> {
        let lock_file = self.lock_path(session_id);
        if lock_file.exists() {
            fs::remove_file(lock_file).await?;
        }
        Ok(())
    }

    pub async fn append_event(&self, event: LedgerEvent) -> Result<(), LedgerError> {
        let session_id = &event.session_id;
        self.acquire_lock(session_id).await?;
        
        let ledger_path = self.ledger_path(session_id);
        if let Some(parent) = ledger_path.parent() {
            fs::create_dir_all(parent).await?;
        }
        
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&ledger_path)
            .await?;
            
        let json_line = serde_json::to_string(&event)? + "\n";
        file.write_all(json_line.as_bytes()).await?;
        file.flush().await?;

        self.release_lock(session_id).await?;
        Ok(())
    }

    // TODO: load_state, apply_event
}
