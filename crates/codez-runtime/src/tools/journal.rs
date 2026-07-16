use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use thiserror::Error;
use tokio::fs::{self, OpenOptions};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolJournalIdentity {
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub context_scope_id: Option<String>,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub api_format: Option<String>,
    pub catalog_snapshot_id: Option<String>,
    pub exposure_plan_id: Option<String>,
    pub schema_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolJournalEvent {
    #[serde(flatten)]
    pub identity: Option<ToolJournalIdentity>,
    pub event: String,
    pub timestamp: Option<String>,
    pub call_id: Option<String>,
    pub tool_name: Option<String>,
    pub source: Option<String>,
    pub descriptor_version: Option<String>,
    pub status: Option<String>,
    pub decision: Option<String>,
    pub error_code: Option<String>,
    pub recoverable: Option<bool>,
    pub input_bytes: Option<usize>,
    pub result_bytes: Option<usize>,
    pub model_result_bytes: Option<usize>,
    pub persisted_bytes: Option<usize>,
    pub resource_key_count: Option<usize>,
    pub wave: Option<usize>,
    pub queue_duration_ms: Option<u32>,
    pub execution_duration_ms: Option<u32>,
    pub hook_duration_ms: Option<u32>,
    pub batch_size: Option<usize>,
    pub permission_rule_id: Option<String>,
    pub permission_mode: Option<String>,
}

#[derive(Clone)]
pub struct ToolExecutionJournal {
    file_path: PathBuf,
    max_bytes: u64,
    max_files: u32,
    lock: Arc<Mutex<()>>,
}

#[derive(Debug, Error)]
pub enum ToolJournalError {
    #[error("failed to serialize a tool journal event")]
    Serialize(#[from] serde_json::Error),
    #[error("tool journal I/O failed")]
    Io(#[from] std::io::Error),
}

impl ToolExecutionJournal {
    pub fn new(file_path: PathBuf, max_bytes: Option<u64>, max_files: Option<u32>) -> Self {
        Self {
            file_path,
            max_bytes: max_bytes.unwrap_or(10 * 1024 * 1024),
            max_files: max_files.unwrap_or(5),
            lock: Arc::new(Mutex::new(())),
        }
    }

    async fn rotate_if_needed(&self, next_bytes: u64) -> std::io::Result<()> {
        let size = match fs::metadata(&self.file_path).await {
            Ok(m) => m.len(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
            Err(e) => return Err(e),
        };

        if size + next_bytes <= self.max_bytes {
            return Ok(());
        }

        for i in (1..self.max_files).rev() {
            let src = if i == 1 {
                self.file_path.clone()
            } else {
                self.file_path.with_extension(format!("jsonl.{}", i - 1))
            };
            let dst = self.file_path.with_extension(format!("jsonl.{}", i));

            let _ = fs::remove_file(&dst).await;
            if let Err(e) = fs::rename(&src, &dst).await {
                if e.kind() != std::io::ErrorKind::NotFound {
                    return Err(e);
                }
            }
        }

        Ok(())
    }

    pub async fn append(&self, mut event: ToolJournalEvent) -> Result<(), ToolJournalError> {
        if event.timestamp.is_none() {
            event.timestamp = Some(Utc::now().to_rfc3339());
        }

        let line = format!("{}\n", serde_json::to_string(&event)?);
        let bytes = line.as_bytes();

        let _guard = self.lock.lock().await;

        if let Some(parent) = self.file_path.parent() {
            fs::create_dir_all(parent).await?;
        }

        self.rotate_if_needed(bytes.len() as u64).await?;

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file_path)
            .await?;

        file.write_all(bytes).await?;
        Ok(())
    }
}
