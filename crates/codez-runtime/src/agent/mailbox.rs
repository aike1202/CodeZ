use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use codez_core::agent::AgentMessage;
use codez_core::{AgentAttemptId, AgentId, AppError, AtomicPersistence, MessageId, RootRunId};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::{Mutex, Notify};

const MAILBOX_SCHEMA_VERSION: u16 = 1;
const MAILBOX_FILE: &str = "mailbox.jsonl";
const MAX_MESSAGE_SUMMARY_BYTES: usize = 2 * 1024;

type MailboxNotificationKey = (RootRunId, AgentId);
type MailboxNotifications = HashMap<MailboxNotificationKey, Arc<Notify>>;

#[derive(Debug, Error)]
pub enum MailboxError {
    #[error("mailbox summary cannot be empty")]
    EmptySummary,
    #[error("mailbox summary exceeds {MAX_MESSAGE_SUMMARY_BYTES} bytes; use an artifact reference")]
    SummaryTooLarge,
    #[error("mailbox record could not be serialized")]
    Serialize(#[source] serde_json::Error),
    #[error("mailbox ledger contains invalid JSON at line {line}")]
    InvalidJson {
        line: usize,
        #[source]
        source: serde_json::Error,
    },
    #[error("mailbox ledger has unsupported schema version {0}")]
    UnsupportedSchema(u16),
    #[error("mailbox record belongs to another root run")]
    RootMismatch,
    #[error("mailbox sequence overflowed for recipient {0}")]
    SequenceOverflow(String),
    #[error("mailbox message {0} was not found")]
    MessageNotFound(String),
    #[error(transparent)]
    Storage(#[from] AppError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxAck {
    pub message_id: MessageId,
    pub attempt_id: AgentAttemptId,
    pub acknowledged_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MailboxRecord {
    schema_version: u16,
    root_run_id: RootRunId,
    record_id: String,
    record: MailboxRecordKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
enum MailboxRecordKind {
    Message(AgentMessage),
    Ack(MailboxAck),
}

#[derive(Default)]
struct LoadedMailbox {
    messages: Vec<AgentMessage>,
    acks: HashSet<(MessageId, AgentAttemptId)>,
}

#[derive(Clone)]
pub struct DurableMailbox {
    runtime_root: PathBuf,
    persistence: Arc<dyn AtomicPersistence>,
    writer: Arc<Mutex<()>>,
    notifications: Arc<StdMutex<MailboxNotifications>>,
}

impl DurableMailbox {
    #[must_use]
    pub fn new(runtime_root: impl AsRef<Path>, persistence: Arc<dyn AtomicPersistence>) -> Self {
        Self {
            runtime_root: runtime_root.as_ref().to_path_buf(),
            persistence,
            writer: Arc::new(Mutex::new(())),
            notifications: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    #[must_use]
    pub fn ledger_path(&self, root_run_id: &RootRunId) -> PathBuf {
        self.runtime_root
            .join(root_storage_key(root_run_id))
            .join(MAILBOX_FILE)
    }

    pub async fn send(&self, mut message: AgentMessage) -> Result<AgentMessage, MailboxError> {
        validate_summary(&message.summary)?;
        let _writer = self.writer.lock().await;
        let loaded = self.load_unlocked(&message.root_run_id).await?;
        if let Some(idempotency_key) = message.idempotency_key.as_deref() {
            if let Some(existing) = loaded.messages.iter().find(|existing| {
                existing.from == message.from
                    && existing.to == message.to
                    && existing.idempotency_key.as_deref() == Some(idempotency_key)
            }) {
                return Ok(existing.clone());
            }
        }
        message.sequence = loaded
            .messages
            .iter()
            .filter(|existing| existing.to == message.to)
            .map(|existing| existing.sequence)
            .max()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| MailboxError::SequenceOverflow(message.to.to_string()))?;
        let record = MailboxRecord {
            schema_version: MAILBOX_SCHEMA_VERSION,
            root_run_id: message.root_run_id.clone(),
            record_id: message.id.to_string(),
            record: MailboxRecordKind::Message(message.clone()),
        };
        self.append(&record).await?;
        self.notification(&message.root_run_id, &message.to)
            .notify_waiters();
        Ok(message)
    }

    pub async fn list_after(
        &self,
        root_run_id: &RootRunId,
        recipient: &AgentId,
        after_cursor: u64,
        limit: usize,
    ) -> Result<Vec<AgentMessage>, MailboxError> {
        let _writer = self.writer.lock().await;
        let loaded = self.load_unlocked(root_run_id).await?;
        Ok(loaded
            .messages
            .into_iter()
            .filter(|message| message.to == *recipient && message.sequence > after_cursor)
            .take(limit)
            .collect())
    }

    pub async fn wait_after(
        &self,
        root_run_id: &RootRunId,
        recipient: &AgentId,
        after_cursor: u64,
        limit: usize,
        timeout: Duration,
    ) -> Result<Vec<AgentMessage>, MailboxError> {
        let initial = self
            .list_after(root_run_id, recipient, after_cursor, limit)
            .await?;
        if !initial.is_empty() {
            return Ok(initial);
        }
        let notification = self.notification(root_run_id, recipient);
        let notified = notification.notified();
        let second = self
            .list_after(root_run_id, recipient, after_cursor, limit)
            .await?;
        if !second.is_empty() {
            return Ok(second);
        }
        let _ = tokio::time::timeout(timeout, notified).await;
        self.list_after(root_run_id, recipient, after_cursor, limit)
            .await
    }

    pub async fn ack(
        &self,
        root_run_id: &RootRunId,
        ack: MailboxAck,
        record_id: String,
    ) -> Result<bool, MailboxError> {
        let _writer = self.writer.lock().await;
        let loaded = self.load_unlocked(root_run_id).await?;
        if !loaded
            .messages
            .iter()
            .any(|message| message.id == ack.message_id)
        {
            return Err(MailboxError::MessageNotFound(ack.message_id.to_string()));
        }
        let key = (ack.message_id.clone(), ack.attempt_id.clone());
        if loaded.acks.contains(&key) {
            return Ok(false);
        }
        let record = MailboxRecord {
            schema_version: MAILBOX_SCHEMA_VERSION,
            root_run_id: root_run_id.clone(),
            record_id,
            record: MailboxRecordKind::Ack(ack),
        };
        self.append(&record).await?;
        Ok(true)
    }

    async fn load_unlocked(&self, root_run_id: &RootRunId) -> Result<LoadedMailbox, MailboxError> {
        let Some(bytes) = self
            .persistence
            .read(&self.ledger_path(root_run_id))
            .await?
        else {
            return Ok(LoadedMailbox::default());
        };
        let mut loaded = LoadedMailbox::default();
        for (line_index, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
            if line.is_empty() {
                continue;
            }
            let record = serde_json::from_slice::<MailboxRecord>(line).map_err(|source| {
                MailboxError::InvalidJson {
                    line: line_index + 1,
                    source,
                }
            })?;
            if record.schema_version != MAILBOX_SCHEMA_VERSION {
                return Err(MailboxError::UnsupportedSchema(record.schema_version));
            }
            if record.root_run_id != *root_run_id {
                return Err(MailboxError::RootMismatch);
            }
            match record.record {
                MailboxRecordKind::Message(message) => loaded.messages.push(message),
                MailboxRecordKind::Ack(ack) => {
                    loaded.acks.insert((ack.message_id, ack.attempt_id));
                }
            }
        }
        Ok(loaded)
    }

    async fn append(&self, record: &MailboxRecord) -> Result<(), MailboxError> {
        let mut bytes = serde_json::to_vec(record).map_err(MailboxError::Serialize)?;
        bytes.push(b'\n');
        self.persistence
            .append(&self.ledger_path(&record.root_run_id), &bytes)
            .await?;
        Ok(())
    }

    fn notification(&self, root_run_id: &RootRunId, agent_id: &AgentId) -> Arc<Notify> {
        Arc::clone(
            self.notifications
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .entry((root_run_id.clone(), agent_id.clone()))
                .or_insert_with(|| Arc::new(Notify::new())),
        )
    }
}

fn validate_summary(summary: &str) -> Result<(), MailboxError> {
    if summary.trim().is_empty() {
        return Err(MailboxError::EmptySummary);
    }
    if summary.len() > MAX_MESSAGE_SUMMARY_BYTES {
        return Err(MailboxError::SummaryTooLarge);
    }
    Ok(())
}

fn root_storage_key(root_run_id: &RootRunId) -> String {
    format!(
        "root-{}",
        hex::encode(Sha256::digest(root_run_id.as_str().as_bytes()))
    )
}
