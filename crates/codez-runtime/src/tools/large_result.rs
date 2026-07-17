use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::fs::{self, OpenOptions};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

fn sha256_hex(data: impl AsRef<[u8]>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedToolResult {
    pub handle: String,
    pub original_chars: usize,
    pub original_bytes: usize,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolResultMetadata {
    #[serde(flatten)]
    pub persisted: PersistedToolResult,
    pub created_at: String,
    pub workspace_hash: String,
    pub session_hash: String,
    pub call_id: String,
    pub tool_name: String,
    pub content_type: String,
}

pub struct LargeToolResultStore {
    root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub content: String,
    pub offset: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<usize>,
    pub total_chars: usize,
}

impl LargeToolResultStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn session_dir(&self, workspace_root: &Path, session_id: &str) -> PathBuf {
        let ws_hash = sha256_hex(workspace_root.to_string_lossy().as_bytes());
        let session_hash = sha256_hex(session_id.as_bytes());
        self.root
            .join("projects")
            .join(ws_hash)
            .join("sessions")
            .join(session_hash)
    }

    pub async fn persist(
        &self,
        workspace_root: &Path,
        session_id: &str,
        call_id: &str,
        tool_name: &str,
        content: &str,
    ) -> std::io::Result<PersistedToolResult> {
        let call_id_hash = sha256_hex(call_id.as_bytes());
        let id = format!(
            "{}_{}",
            &call_id_hash[0..16],
            Uuid::new_v4().to_string().replace("-", "")
        );
        let handle = format!("tool-result://{}", id);
        let dir = self.session_dir(workspace_root, session_id);

        fs::create_dir_all(&dir).await?;

        let content_path = dir.join(format!("{}.txt", id));
        let metadata_path = dir.join(format!("{}.json", id));

        let body_bytes = content.as_bytes();
        let persisted = PersistedToolResult {
            handle,
            original_chars: content.chars().count(),
            original_bytes: body_bytes.len(),
            sha256: sha256_hex(body_bytes),
        };

        let metadata = ToolResultMetadata {
            persisted: persisted.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
            workspace_hash: sha256_hex(workspace_root.to_string_lossy().as_bytes()),
            session_hash: sha256_hex(session_id.as_bytes()),
            call_id: call_id.to_string(),
            tool_name: tool_name.to_string(),
            content_type: "text/plain".to_string(),
        };

        let mut content_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&content_path)
            .await?;
        content_file.write_all(body_bytes).await?;
        content_file.flush().await?;

        let mut metadata_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&metadata_path)
            .await?;
        let metadata_json = serde_json::to_string(&metadata)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        metadata_file.write_all(metadata_json.as_bytes()).await?;
        metadata_file.flush().await?;

        Ok(persisted)
    }

    pub async fn read(
        &self,
        workspace_root: &Path,
        session_id: &str,
        handle: &str,
        offset: Option<usize>,
        limit: Option<usize>,
    ) -> std::io::Result<ReadResult> {
        let prefix = "tool-result://";
        let Some(id) = handle.strip_prefix(prefix) else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Invalid tool-result handle.",
            ));
        };
        if id.is_empty()
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Invalid tool-result handle.",
            ));
        }
        let dir = self.session_dir(workspace_root, session_id);

        let metadata_path = dir.join(format!("{}.json", id));
        let metadata_content = fs::read_to_string(&metadata_path).await?;
        let metadata: ToolResultMetadata = serde_json::from_str(&metadata_content)?;

        if metadata.persisted.handle != handle
            || metadata.workspace_hash != sha256_hex(workspace_root.to_string_lossy().as_bytes())
            || metadata.session_hash != sha256_hex(session_id.as_bytes())
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Tool-result handle does not belong to this session.",
            ));
        }

        let content_path = dir.join(format!("{}.txt", id));
        let full_content = fs::read_to_string(&content_path).await?;
        if metadata.persisted.original_chars != full_content.chars().count()
            || metadata.persisted.original_bytes != full_content.len()
            || metadata.persisted.sha256 != sha256_hex(full_content.as_bytes())
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Persisted tool-result content failed its integrity check.",
            ));
        }

        // This offset is roughly assumed to be in chars like TS does `full.slice(offset, end)`
        // In Rust, String slicing is by byte, so we collect to chars first to match TS behavior for safe truncation
        let chars: Vec<char> = full_content.chars().collect();
        let mut actual_offset = offset.unwrap_or(0);
        if actual_offset > chars.len() {
            actual_offset = chars.len();
        }

        let actual_limit = limit.unwrap_or(20_000).clamp(1, 50_000);

        let end = std::cmp::min(chars.len(), actual_offset + actual_limit);
        let content_slice: String = chars[actual_offset..end].iter().collect();

        Ok(ReadResult {
            content: content_slice,
            offset: actual_offset,
            next_offset: if end < chars.len() { Some(end) } else { None },
            total_chars: chars.len(),
        })
    }

    pub async fn remove_session(
        &self,
        workspace_root: &Path,
        session_id: &str,
    ) -> std::io::Result<()> {
        let dir = self.session_dir(workspace_root, session_id);
        fs::remove_dir_all(dir).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn read_rejects_a_path_like_handle() {
        let root = tempfile::tempdir().expect("temporary result root must be available");
        let store = LargeToolResultStore::new(root.path().to_path_buf());

        let error = store
            .read(
                root.path(),
                "session-a",
                "tool-result://../outside",
                None,
                None,
            )
            .await
            .expect_err("path-like handles must be rejected");

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn read_rejects_content_that_no_longer_matches_metadata() {
        let root = tempfile::tempdir().expect("temporary result root must be available");
        let store = LargeToolResultStore::new(root.path().join("results"));
        let persisted = store
            .persist(root.path(), "session-a", "call-a", "Read", "original")
            .await
            .expect("fixture result must persist");
        let id = persisted
            .handle
            .strip_prefix("tool-result://")
            .expect("persisted handles must use the opaque prefix");
        let content_path = store
            .session_dir(root.path(), "session-a")
            .join(format!("{id}.txt"));
        tokio::fs::write(content_path, "tampered")
            .await
            .expect("fixture content must be modified");

        let error = store
            .read(root.path(), "session-a", &persisted.handle, None, None)
            .await
            .expect_err("tampered content must not be returned");

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }
}
