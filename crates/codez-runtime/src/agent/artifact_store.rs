use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use codez_core::{AgentAttemptId, AgentId, AppError, ArtifactId, AtomicPersistence, RootRunId};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::Mutex;

const ARTIFACT_SCHEMA_VERSION: u16 = 1;
const MANIFEST_FILE: &str = "artifacts.json";
const MAX_MESSAGE_ARTIFACT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum AgentArtifactError {
    #[error("Agent artifact content cannot be empty")]
    EmptyContent,
    #[error("Agent artifact content exceeds {MAX_MESSAGE_ARTIFACT_BYTES} bytes")]
    ContentTooLarge,
    #[error("Agent artifact manifest could not be encoded or decoded")]
    Serialize(#[from] serde_json::Error),
    #[error("Agent artifact manifest uses unsupported schema version {0}")]
    UnsupportedSchema(u16),
    #[error("Agent artifact manifest belongs to another root run")]
    RootMismatch,
    #[error(transparent)]
    Storage(#[from] AppError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredAgentArtifact {
    pub artifact_id: ArtifactId,
    pub owner_agent_id: AgentId,
    pub owner_attempt_id: AgentAttemptId,
    pub name: String,
    pub kind: String,
    pub path: PathBuf,
    pub sha256: String,
    pub size_bytes: u64,
    pub preview: Option<String>,
    pub preview_truncated: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactManifest {
    schema_version: u16,
    root_run_id: RootRunId,
    artifacts: Vec<ArtifactRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactRecord {
    artifact_id: ArtifactId,
    owner_agent_id: AgentId,
    owner_attempt_id: AgentAttemptId,
    name: String,
    kind: String,
    file_name: String,
    sha256: String,
    size_bytes: u64,
    created_at: String,
}

#[derive(Clone)]
pub struct AgentArtifactStore {
    runtime_root: PathBuf,
    persistence: Arc<dyn AtomicPersistence>,
    writer: Arc<Mutex<()>>,
}

impl AgentArtifactStore {
    #[must_use]
    pub fn new(runtime_root: impl AsRef<Path>, persistence: Arc<dyn AtomicPersistence>) -> Self {
        Self {
            runtime_root: runtime_root.as_ref().to_path_buf(),
            persistence,
            writer: Arc::new(Mutex::new(())),
        }
    }

    pub async fn persist_message(
        &self,
        root_run_id: &RootRunId,
        owner_agent_id: &AgentId,
        owner_attempt_id: &AgentAttemptId,
        content: &str,
        created_at: String,
    ) -> Result<StoredAgentArtifact, AgentArtifactError> {
        if content.trim().is_empty() {
            return Err(AgentArtifactError::EmptyContent);
        }
        if content.len() > MAX_MESSAGE_ARTIFACT_BYTES {
            return Err(AgentArtifactError::ContentTooLarge);
        }
        let _writer = self.writer.lock().await;
        let mut manifest = self.load_manifest(root_run_id).await?;
        let sha256 = sha256_hex(content.as_bytes());
        let identity_hash = sha256_hex(
            format!(
                "{}\0{}\0{}\0{}",
                root_run_id, owner_agent_id, owner_attempt_id, sha256
            )
            .as_bytes(),
        );
        let artifact_id = ArtifactId::parse(format!("artifact_message_{identity_hash}"))
            .map_err(|error| AppError::internal(error.to_string()))?;
        if let Some(existing) = manifest
            .artifacts
            .iter()
            .find(|artifact| artifact.artifact_id == artifact_id)
        {
            return self.load_artifact(root_run_id, existing, usize::MAX).await;
        }
        let file_name = format!("{identity_hash}.txt");
        let path = self.root_path(root_run_id).join(&file_name);
        self.persistence.replace(&path, content.as_bytes()).await?;
        let record = ArtifactRecord {
            artifact_id,
            owner_agent_id: owner_agent_id.clone(),
            owner_attempt_id: owner_attempt_id.clone(),
            name: format!("message-{}.txt", &identity_hash[..12]),
            kind: "message_payload".to_string(),
            file_name,
            sha256,
            size_bytes: u64::try_from(content.len()).unwrap_or(u64::MAX),
            created_at,
        };
        manifest.artifacts.push(record.clone());
        self.save_manifest(&manifest).await?;
        self.load_artifact(root_run_id, &record, usize::MAX).await
    }

    pub async fn list_for_agent(
        &self,
        root_run_id: &RootRunId,
        agent_id: &AgentId,
        preview_bytes: usize,
    ) -> Result<Vec<StoredAgentArtifact>, AgentArtifactError> {
        let _writer = self.writer.lock().await;
        let manifest = self.load_manifest(root_run_id).await?;
        let mut artifacts = Vec::new();
        for record in manifest
            .artifacts
            .iter()
            .filter(|record| record.owner_agent_id == *agent_id)
        {
            artifacts.push(
                self.load_artifact(root_run_id, record, preview_bytes)
                    .await?,
            );
        }
        artifacts.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.artifact_id.cmp(&right.artifact_id))
        });
        Ok(artifacts)
    }

    async fn load_manifest(
        &self,
        root_run_id: &RootRunId,
    ) -> Result<ArtifactManifest, AgentArtifactError> {
        let path = self.root_path(root_run_id).join(MANIFEST_FILE);
        let Some(bytes) = self.persistence.read(&path).await? else {
            return Ok(ArtifactManifest {
                schema_version: ARTIFACT_SCHEMA_VERSION,
                root_run_id: root_run_id.clone(),
                artifacts: Vec::new(),
            });
        };
        let manifest = serde_json::from_slice::<ArtifactManifest>(&bytes)?;
        if manifest.schema_version != ARTIFACT_SCHEMA_VERSION {
            return Err(AgentArtifactError::UnsupportedSchema(
                manifest.schema_version,
            ));
        }
        if manifest.root_run_id != *root_run_id {
            return Err(AgentArtifactError::RootMismatch);
        }
        Ok(manifest)
    }

    async fn save_manifest(&self, manifest: &ArtifactManifest) -> Result<(), AgentArtifactError> {
        let bytes = serde_json::to_vec_pretty(manifest)?;
        self.persistence
            .replace(
                &self.root_path(&manifest.root_run_id).join(MANIFEST_FILE),
                &bytes,
            )
            .await?;
        Ok(())
    }

    async fn load_artifact(
        &self,
        root_run_id: &RootRunId,
        record: &ArtifactRecord,
        preview_bytes: usize,
    ) -> Result<StoredAgentArtifact, AgentArtifactError> {
        let path = self.root_path(root_run_id).join(&record.file_name);
        let bytes = self.persistence.read(&path).await?.unwrap_or_default();
        let preview_length = bytes.len().min(preview_bytes);
        let preview = (preview_bytes > 0)
            .then(|| String::from_utf8_lossy(&bytes[..preview_length]).into_owned());
        Ok(StoredAgentArtifact {
            artifact_id: record.artifact_id.clone(),
            owner_agent_id: record.owner_agent_id.clone(),
            owner_attempt_id: record.owner_attempt_id.clone(),
            name: record.name.clone(),
            kind: record.kind.clone(),
            path,
            sha256: record.sha256.clone(),
            size_bytes: record.size_bytes,
            preview,
            preview_truncated: bytes.len() > preview_length,
            created_at: record.created_at.clone(),
        })
    }

    fn root_path(&self, root_run_id: &RootRunId) -> PathBuf {
        self.runtime_root.join(format!(
            "root-{}",
            sha256_hex(root_run_id.as_str().as_bytes())
        ))
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use codez_core::{AgentAttemptId, AgentId, AtomicPersistence, RootRunId};
    use codez_storage::AtomicFileStore;

    use super::AgentArtifactStore;

    #[tokio::test]
    async fn message_artifact_should_be_idempotent_and_survive_store_reconstruction() {
        let directory = tempfile::tempdir().expect("temporary artifact root must exist");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let root = RootRunId::parse("root-artifact").expect("root ID must parse");
        let agent = AgentId::parse("agent-artifact").expect("Agent ID must parse");
        let attempt = AgentAttemptId::parse("attempt-artifact").expect("attempt ID must parse");
        let store = AgentArtifactStore::new(directory.path(), Arc::clone(&persistence));
        let first = store
            .persist_message(
                &root,
                &agent,
                &attempt,
                "large durable evidence",
                "2026-07-19T00:00:00Z".to_string(),
            )
            .await
            .expect("message artifact must persist");
        let replayed = store
            .persist_message(
                &root,
                &agent,
                &attempt,
                "large durable evidence",
                "2026-07-19T00:00:00Z".to_string(),
            )
            .await
            .expect("message artifact replay must be idempotent");
        let reconstructed = AgentArtifactStore::new(directory.path(), persistence);
        let artifacts = reconstructed
            .list_for_agent(&root, &agent, 8)
            .await
            .expect("artifact catalog must reload");

        assert_eq!(first.artifact_id, replayed.artifact_id);
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].preview.as_deref(), Some("large du"));
        assert!(artifacts[0].preview_truncated);
    }
}
