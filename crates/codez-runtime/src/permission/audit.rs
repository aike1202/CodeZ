use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use chrono::Utc;
use codez_core::{AppError, AtomicPersistence};
use regex::Regex;
use serde_json::Value;
use thiserror::Error;

static AUTHORIZATION_VALUE: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"(?i)(authorization\s*:\s*(?:bearer|basic)\s+)\S+"));
static ASSIGNMENT_VALUE: LazyLock<Result<Regex, regex::Error>> = LazyLock::new(|| {
    Regex::new(r#"(?i)((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s\"']+"#)
});

#[derive(Debug, Error)]
pub enum PermissionAuditError {
    #[error("the CodeZ data root must be an absolute path")]
    InvalidDataRoot,
    #[error("a permission audit event must be a JSON object")]
    InvalidEvent,
    #[error("the permission audit event could not be serialized")]
    Serialize(#[source] serde_json::Error),
    #[error(transparent)]
    Persistence(#[from] AppError),
}

#[derive(Clone)]
pub struct PermissionAuditLog {
    file_path: PathBuf,
    persistence: Arc<dyn AtomicPersistence>,
}

impl PermissionAuditLog {
    pub fn new(
        data_root: &Path,
        persistence: Arc<dyn AtomicPersistence>,
    ) -> Result<Self, PermissionAuditError> {
        if !data_root.is_absolute() {
            return Err(PermissionAuditError::InvalidDataRoot);
        }
        Ok(Self {
            file_path: data_root.join("permission-audit.jsonl"),
            persistence,
        })
    }

    pub async fn append(&self, event: Value) -> Result<(), PermissionAuditError> {
        let Value::Object(mut event) = event else {
            return Err(PermissionAuditError::InvalidEvent);
        };
        event.insert(
            "timestamp".to_string(),
            Value::String(Utc::now().to_rfc3339()),
        );
        let mut safe = Value::Object(event);
        redact_value(&mut safe);
        let mut bytes = serde_json::to_vec(&safe).map_err(PermissionAuditError::Serialize)?;
        bytes.push(b'\n');
        self.persistence.append(&self.file_path, &bytes).await?;
        Ok(())
    }
}

fn redact_value(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                if is_secret_key(key) {
                    *value = Value::String("[REDACTED]".to_string());
                } else {
                    redact_value(value);
                }
            }
        }
        Value::Array(values) => values.iter_mut().for_each(redact_value),
        Value::String(text) => {
            let authorization_redacted = AUTHORIZATION_VALUE.as_ref().map_or_else(
                |_| text.clone(),
                |regex| regex.replace_all(text, "${1}[REDACTED]").into_owned(),
            );
            *text = ASSIGNMENT_VALUE
                .as_ref()
                .map_or(authorization_redacted.clone(), |regex| {
                    regex
                        .replace_all(&authorization_redacted, "${1}[REDACTED]")
                        .into_owned()
                });
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn is_secret_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace('-', "_");
    [
        "api_key",
        "apikey",
        "token",
        "password",
        "secret",
        "authorization",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

#[cfg(test)]
mod tests {
    use std::{
        path::Path,
        sync::{Arc, Mutex},
    };

    use codez_core::{AppError, AtomicCreateOutcome, AtomicPersistence, PortFuture};
    use serde_json::json;

    use super::PermissionAuditLog;

    #[derive(Debug, Default)]
    struct RecordingPersistence {
        bytes: Mutex<Vec<u8>>,
    }

    impl RecordingPersistence {
        fn bytes(&self) -> Vec<u8> {
            self.bytes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }
    }

    impl AtomicPersistence for RecordingPersistence {
        fn read<'a>(&'a self, _path: &'a Path) -> PortFuture<'a, Option<Vec<u8>>> {
            Box::pin(async move {
                let bytes = self.bytes();
                Ok((!bytes.is_empty()).then_some(bytes))
            })
        }

        fn replace<'a>(&'a self, _path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
            Box::pin(async move {
                *self
                    .bytes
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = bytes.to_vec();
                Ok(())
            })
        }

        fn create_no_clobber<'a>(
            &'a self,
            _path: &'a Path,
            bytes: &'a [u8],
        ) -> PortFuture<'a, AtomicCreateOutcome> {
            Box::pin(async move {
                let mut current = self
                    .bytes
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if current.is_empty() {
                    *current = bytes.to_vec();
                    Ok(AtomicCreateOutcome::Created)
                } else if current.as_slice() == bytes {
                    Ok(AtomicCreateOutcome::Reused)
                } else {
                    Err(AppError::conflict(
                        "The recording persistence target contains different bytes",
                    ))
                }
            })
        }

        fn append<'a>(&'a self, _path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
            Box::pin(async move {
                self.bytes
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .extend_from_slice(bytes);
                Ok(())
            })
        }

        fn remove<'a>(&'a self, _path: &'a Path) -> PortFuture<'a, bool> {
            Box::pin(async move {
                let mut bytes = self
                    .bytes
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let existed = !bytes.is_empty();
                bytes.clear();
                Ok(existed)
            })
        }
    }

    #[tokio::test]
    async fn append_redacts_nested_secrets_before_atomic_persistence() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let persistence = Arc::new(RecordingPersistence::default());
        let port: Arc<dyn AtomicPersistence> = persistence.clone();
        let log = PermissionAuditLog::new(directory.path(), port)
            .expect("absolute fixture data root must be accepted");

        log.append(json!({
            "args": { "apiKey": "private-value" },
            "message": "Authorization: Bearer private-token"
        }))
        .await
        .expect("audit event must persist");
        let content = String::from_utf8(persistence.bytes())
            .expect("audit persistence must contain UTF-8 JSONL");

        assert!(!content.contains("private-value") && !content.contains("private-token"));
    }
}
