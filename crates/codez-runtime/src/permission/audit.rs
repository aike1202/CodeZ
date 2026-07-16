use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs::{self, OpenOptions};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use chrono::Utc;
use regex::Regex;
use serde_json::Value;

lazy_static::lazy_static! {
    static ref RE1: Regex = Regex::new(r#"(?i)("(?:api[_-]?key|token|password|secret)"\s*:\s*")[^"]*"#).unwrap();
    static ref RE2: Regex = Regex::new(r#"(?i)(authorization\s*:\s*(?:bearer|basic)\s+)\S+"#).unwrap();
    static ref RE3: Regex = Regex::new(r#"(?i)((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s"']+"#).unwrap();
}

fn redact(value: &str) -> String {
    let s = RE1.replace_all(value, "${1}[REDACTED]");
    let s = RE2.replace_all(&s, "${1}[REDACTED]");
    RE3.replace_all(&s, "${1}[REDACTED]").to_string()
}

#[derive(Clone)]
pub struct PermissionAuditLog {
    file_path: Option<PathBuf>,
    lock: Arc<Mutex<()>>,
}

impl PermissionAuditLog {
    pub fn new(file_path: Option<PathBuf>) -> Self {
        Self {
            file_path,
            lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn append(&self, event: Value) {
        let path = match &self.file_path {
            Some(p) => p,
            None => return,
        };

        let mut map = match event {
            Value::Object(m) => m,
            _ => return,
        };

        map.insert("timestamp".to_string(), Value::String(Utc::now().to_rfc3339()));
        
        let raw_json = serde_json::to_string(&map).unwrap_or_default();
        let redacted = redact(&raw_json);
        
        // Ensure it's still valid JSON after redaction
        let safe_json: Value = serde_json::from_str(&redacted).unwrap_or(Value::Null);
        if safe_json.is_null() {
            return;
        }

        let line = format!("{}\n", serde_json::to_string(&safe_json).unwrap());

        let _guard = self.lock.lock().await;

        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent).await;
        }

        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path).await {
            let _ = file.write_all(line.as_bytes()).await;
        }
    }
}
