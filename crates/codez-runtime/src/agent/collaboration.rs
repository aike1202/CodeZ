use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use codez_core::{AppError, AtomicPersistence, CancellationToken, SessionId, WorkspaceRoot};
use dashmap::DashMap;
use futures::FutureExt;
use serde::{Deserialize, Serialize};
use tokio::{
    fs as async_fs,
    sync::{Mutex, Notify},
};
use tokio_util::task::TaskTracker;
use uuid::Uuid;

use crate::host::{ShutdownFuture, ShutdownHook, ShutdownPhase};

pub const AGENT_RUNTIME_EVENT_VERSION: u16 = 1;
const AGENT_RUNTIME_DIRECTORY: &str = "agent-runtime";
const AGENT_RUNTIME_SNAPSHOT_VERSION: u16 = 1;
const ROOT_AGENT_PATH: &str = "/root";
const MAIN_CONTEXT_SCOPE: &str = "main";
const MAX_AGENT_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_AGENTS_PER_SESSION: usize = 200;
const MAX_MESSAGES_PER_SESSION: usize = 512;
const MAX_GENERAL_MESSAGES_PER_SESSION: usize = 500;
const MAX_ACTIVE_ATTEMPTS: usize = 8;
const MAX_TASK_NAME_BYTES: usize = 64;
const MAX_ROLE_BYTES: usize = 64;
const MAX_DESCRIPTION_BYTES: usize = 4 * 1024;
const MAX_MESSAGE_BYTES: usize = 128 * 1024;
const MAX_CONTEXT_BYTES: usize = 256 * 1024;
const MAX_LIST_ITEMS: usize = 128;
const MAX_LIST_ITEM_BYTES: usize = 4 * 1024;
const CLEANUP_WAIT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimeStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Interrupted,
}

impl AgentRuntimeStatus {
    #[must_use]
    pub const fn is_active(self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }

    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Interrupted)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AgentMessageType {
    NewTask,
    Message,
    FinalAnswer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentMessageDeliveryState {
    Unread,
    Read,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentDepth {
    Quick,
    Normal,
    Exhaustive,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentExpectations {
    #[serde(default)]
    pub questions: Vec<String>,
    #[serde(default)]
    pub out_of_scope: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentScope {
    #[serde(default)]
    pub directories: Vec<String>,
    #[serde(default)]
    pub exclude_globs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentLaunchPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expectations: Option<AgentExpectations>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<AgentScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depth: Option<AgentDepth>,
    #[serde(default)]
    pub allowed_write_files: Vec<String>,
    #[serde(default)]
    pub allow_shell: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTerminalResult {
    pub status: AgentRuntimeStatus,
    pub report: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conclusion: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRecord {
    pub agent_id: String,
    pub session_id: SessionId,
    pub parent_agent_id: String,
    pub parent_path: String,
    pub path: String,
    pub role: String,
    pub task_name: String,
    pub description: String,
    pub context_scope_id: String,
    pub status: AgentRuntimeStatus,
    pub attempt_id: String,
    pub run_count: u32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub launch: AgentLaunchPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<AgentTerminalResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMailboxMessage {
    pub message_id: String,
    pub message_type: AgentMessageType,
    pub attempt_id: String,
    pub author: String,
    pub recipient: String,
    pub payload: String,
    pub delivery_state: AgentMessageDeliveryState,
    pub created_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeSnapshot {
    pub version: u16,
    pub session_id: SessionId,
    pub revision: u64,
    pub agents: Vec<AgentRecord>,
    pub messages: Vec<AgentMailboxMessage>,
}

impl AgentRuntimeSnapshot {
    fn empty(session_id: SessionId) -> Self {
        Self {
            version: AGENT_RUNTIME_SNAPSHOT_VERSION,
            session_id,
            revision: 0,
            agents: Vec::new(),
            messages: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SpawnAgentInput {
    pub workspace_root: WorkspaceRoot,
    pub parent_context_scope_id: String,
    pub role: String,
    pub task_name: String,
    pub description: String,
    pub message: String,
    pub launch: AgentLaunchPolicy,
}

#[derive(Debug, Clone)]
pub struct AgentAttemptRequest {
    pub session_id: SessionId,
    pub workspace_root: WorkspaceRoot,
    pub agent: AgentRecord,
    pub task: String,
    pub mailbox_messages: Vec<AgentMailboxMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentAttemptOutput {
    pub report: String,
    pub conclusion: Option<String>,
}

#[async_trait]
pub trait AgentAttemptExecutor: Send + Sync {
    async fn execute(
        &self,
        request: AgentAttemptRequest,
        cancellation: CancellationToken,
    ) -> Result<AgentAttemptOutput, AppError>;
}

pub trait AgentRuntimeEventSink: Send + Sync {
    fn emit(&self, snapshot: &AgentRuntimeSnapshot) -> Result<(), AppError>;
}

#[derive(Default)]
struct NoopAgentRuntimeEventSink;

impl AgentRuntimeEventSink for NoopAgentRuntimeEventSink {
    fn emit(&self, _snapshot: &AgentRuntimeSnapshot) -> Result<(), AppError> {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentWaitOutcome {
    Updated,
    NoActiveAgents,
    Timeout,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentWaitResult {
    pub messages: Vec<AgentMailboxMessage>,
    pub outcome: AgentWaitOutcome,
}

#[derive(Default)]
struct SessionAgentState {
    snapshot: Option<AgentRuntimeSnapshot>,
    notify: Arc<Notify>,
}

struct ActiveAttempt {
    attempt_id: String,
    cancellation: CancellationToken,
}

#[derive(Default)]
struct ActiveRegistry {
    attempts: HashMap<(SessionId, String), ActiveAttempt>,
    deleting_sessions: HashSet<SessionId>,
}

pub struct AgentRuntime {
    root: PathBuf,
    persistence: Arc<dyn AtomicPersistence>,
    events: Arc<dyn AgentRuntimeEventSink>,
    executor: Arc<dyn AgentAttemptExecutor>,
    sessions: DashMap<SessionId, Arc<Mutex<SessionAgentState>>>,
    active: Mutex<ActiveRegistry>,
    tracker: TaskTracker,
    accepting: AtomicBool,
    max_active_attempts: usize,
}

impl AgentRuntime {
    #[must_use]
    pub fn new(
        data_directory: &Path,
        persistence: Arc<dyn AtomicPersistence>,
        executor: Arc<dyn AgentAttemptExecutor>,
    ) -> Self {
        Self::with_event_sink(
            data_directory,
            persistence,
            executor,
            Arc::new(NoopAgentRuntimeEventSink),
        )
    }

    #[must_use]
    pub fn with_event_sink(
        data_directory: &Path,
        persistence: Arc<dyn AtomicPersistence>,
        executor: Arc<dyn AgentAttemptExecutor>,
        events: Arc<dyn AgentRuntimeEventSink>,
    ) -> Self {
        Self::with_limit(
            data_directory,
            persistence,
            executor,
            events,
            MAX_ACTIVE_ATTEMPTS,
        )
    }

    fn with_limit(
        data_directory: &Path,
        persistence: Arc<dyn AtomicPersistence>,
        executor: Arc<dyn AgentAttemptExecutor>,
        events: Arc<dyn AgentRuntimeEventSink>,
        max_active_attempts: usize,
    ) -> Self {
        Self {
            root: data_directory.join(AGENT_RUNTIME_DIRECTORY),
            persistence,
            events,
            executor,
            sessions: DashMap::new(),
            active: Mutex::new(ActiveRegistry::default()),
            tracker: TaskTracker::new(),
            accepting: AtomicBool::new(true),
            max_active_attempts,
        }
    }

    pub async fn snapshot(&self, session_id: &SessionId) -> Result<AgentRuntimeSnapshot, AppError> {
        let state = self.session_state(session_id);
        let mut state = state.lock().await;
        self.ensure_loaded(session_id, &mut state).await?;
        state
            .snapshot
            .clone()
            .ok_or_else(|| AppError::internal("agent runtime snapshot was not loaded"))
    }

    /// Loads every durable session snapshot and resolves interrupted attempts at startup.
    pub async fn recover_all(&self) -> Result<Vec<AgentRuntimeSnapshot>, AppError> {
        let metadata = match async_fs::symlink_metadata(&self.root).await {
            Ok(metadata) => metadata,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => return Err(agent_directory_error(&self.root, source)),
        };
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || is_agent_reparse_point(&metadata)
        {
            return Err(agent_directory_error(
                &self.root,
                "runtime root is not a stable directory",
            ));
        }
        let mut entries = async_fs::read_dir(&self.root)
            .await
            .map_err(|source| agent_directory_error(&self.root, source))?;
        let mut snapshots = Vec::new();
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|source| agent_directory_error(&self.root, source))?
        {
            let path = entry.path();
            let metadata = async_fs::symlink_metadata(&path)
                .await
                .map_err(|source| agent_directory_error(&path, source))?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || is_agent_reparse_point(&metadata)
                || path.extension().and_then(|value| value.to_str()) != Some("json")
            {
                return Err(agent_directory_error(
                    &path,
                    "runtime entry is not a regular JSON document",
                ));
            }
            let session_id = path
                .file_stem()
                .and_then(|value| value.to_str())
                .ok_or_else(|| agent_directory_error(&path, "session file name is not UTF-8"))
                .and_then(|value| {
                    SessionId::parse(value.to_string()).map_err(|source| {
                        agent_directory_error(&path, format!("invalid session file name: {source}"))
                    })
                })?;
            snapshots.push(self.snapshot(&session_id).await?);
        }
        Ok(snapshots)
    }

    pub async fn spawn(
        self: &Arc<Self>,
        session_id: &SessionId,
        input: SpawnAgentInput,
        parent_cancellation: CancellationToken,
    ) -> Result<AgentRecord, AppError> {
        self.ensure_accepting()?;
        validate_spawn_input(&input)?;
        let state = self.session_state(session_id);
        let mut state = state.lock().await;
        self.ensure_loaded(session_id, &mut state).await?;
        let mut next = loaded_snapshot(&state)?;
        if next.agents.len() >= MAX_AGENTS_PER_SESSION {
            return Err(AppError::conflict(
                "The session agent record limit has been reached",
            ));
        }
        ensure_general_message_capacity(&mut next)?;
        let parent = resolve_context_parent(&next, &input.parent_context_scope_id)?;
        let path = format!("{}/{}", parent.path, input.task_name);
        if next.agents.iter().any(|agent| agent.path == path) {
            return Err(AppError::conflict(
                "The requested agent path already exists",
            ));
        }
        let now = Utc::now();
        let agent_id = new_identifier("agent");
        let attempt_id = new_identifier("attempt");
        let record = AgentRecord {
            agent_id: agent_id.clone(),
            session_id: session_id.clone(),
            parent_agent_id: parent.agent_id.clone(),
            parent_path: parent.path.clone(),
            path: path.clone(),
            role: input.role,
            task_name: input.task_name,
            description: normalized_description(&input.description, &input.message),
            context_scope_id: format!("subagent:{agent_id}"),
            status: AgentRuntimeStatus::Queued,
            attempt_id: attempt_id.clone(),
            run_count: 1,
            created_at: now,
            updated_at: now,
            started_at: None,
            completed_at: None,
            launch: input.launch,
            result: None,
        };
        let cancellation = self
            .reserve_attempt(
                session_id,
                &record,
                parent_cancellation,
                parent.agent_id.as_str(),
            )
            .await?;
        next.agents.push(record.clone());
        next.messages.push(AgentMailboxMessage {
            message_id: new_identifier("amsg"),
            message_type: AgentMessageType::NewTask,
            attempt_id: attempt_id.clone(),
            author: parent.path,
            recipient: path,
            payload: input.message.clone(),
            delivery_state: AgentMessageDeliveryState::Unread,
            created_at: now,
            read_at: None,
        });
        bump_revision(&mut next)?;
        if let Err(error) = self.commit(&mut state, next).await {
            self.release_active(session_id, &agent_id, &attempt_id)
                .await;
            return Err(error);
        }
        drop(state);
        self.start_attempt(
            record.clone(),
            input.message,
            input.workspace_root,
            cancellation,
        );
        Ok(record)
    }

    pub async fn followup(
        self: &Arc<Self>,
        session_id: &SessionId,
        requester_context_scope_id: &str,
        target: &str,
        message: String,
        workspace_root: WorkspaceRoot,
        parent_cancellation: CancellationToken,
    ) -> Result<AgentRecord, AppError> {
        self.ensure_accepting()?;
        validate_message("Agent follow-up", &message, MAX_MESSAGE_BYTES)?;
        let state = self.session_state(session_id);
        let mut state = state.lock().await;
        self.ensure_loaded(session_id, &mut state).await?;
        let mut next = loaded_snapshot(&state)?;
        ensure_general_message_capacity(&mut next)?;
        let requester = resolve_context_parent(&next, requester_context_scope_id)?;
        let index = resolve_agent_index(&next, target)?;
        let previous = next.agents[index].clone();
        if requester.path != previous.parent_path {
            return Err(AppError::not_found("The agent target was not found"));
        }
        if previous.status.is_active() {
            return Err(AppError::conflict("The agent is already running"));
        }
        let run_count = previous
            .run_count
            .checked_add(1)
            .ok_or_else(|| AppError::storage("Agent run count is exhausted", "overflow", false))?;
        let attempt_id = new_identifier("attempt");
        let now = Utc::now();
        let agent = &mut next.agents[index];
        agent.status = AgentRuntimeStatus::Queued;
        agent.attempt_id.clone_from(&attempt_id);
        agent.run_count = run_count;
        agent.description = truncate_utf8(message.trim(), MAX_DESCRIPTION_BYTES).to_string();
        agent.updated_at = now;
        agent.started_at = None;
        agent.completed_at = None;
        agent.result = None;
        let record = agent.clone();
        let cancellation = self
            .reserve_attempt(
                session_id,
                &record,
                parent_cancellation,
                previous.parent_agent_id.as_str(),
            )
            .await?;
        next.messages.push(AgentMailboxMessage {
            message_id: new_identifier("amsg"),
            message_type: AgentMessageType::NewTask,
            attempt_id: attempt_id.clone(),
            author: requester.path,
            recipient: record.path.clone(),
            payload: message.clone(),
            delivery_state: AgentMessageDeliveryState::Unread,
            created_at: now,
            read_at: None,
        });
        bump_revision(&mut next)?;
        if let Err(error) = self.commit(&mut state, next).await {
            self.release_active(session_id, &record.agent_id, &attempt_id)
                .await;
            return Err(error);
        }
        drop(state);
        self.start_attempt(record.clone(), message, workspace_root, cancellation);
        Ok(record)
    }

    pub async fn send_message(
        &self,
        session_id: &SessionId,
        sender_context_scope_id: &str,
        target: &str,
        payload: String,
    ) -> Result<AgentMailboxMessage, AppError> {
        validate_message("Agent message", &payload, MAX_MESSAGE_BYTES)?;
        let state = self.session_state(session_id);
        let mut state = state.lock().await;
        self.ensure_loaded(session_id, &mut state).await?;
        let mut next = loaded_snapshot(&state)?;
        ensure_general_message_capacity(&mut next)?;
        let sender = resolve_context_parent(&next, sender_context_scope_id)?;
        let recipient = if target == ROOT_AGENT_PATH {
            ContextParent::root()
        } else {
            let record = &next.agents[resolve_agent_index(&next, target)?];
            ContextParent {
                agent_id: record.agent_id.clone(),
                path: record.path.clone(),
            }
        };
        let attempt_id = attempt_for_message(&next, &sender, &recipient)?;
        let message = AgentMailboxMessage {
            message_id: new_identifier("amsg"),
            message_type: AgentMessageType::Message,
            attempt_id,
            author: sender.path,
            recipient: recipient.path,
            payload,
            delivery_state: AgentMessageDeliveryState::Unread,
            created_at: Utc::now(),
            read_at: None,
        };
        next.messages.push(message.clone());
        bump_revision(&mut next)?;
        self.commit(&mut state, next).await?;
        Ok(message)
    }

    pub async fn list(&self, session_id: &SessionId) -> Result<Vec<AgentRecord>, AppError> {
        self.snapshot(session_id)
            .await
            .map(|snapshot| snapshot.agents)
    }

    pub async fn active_ids(&self, session_id: &SessionId) -> Result<Vec<String>, AppError> {
        Ok(self
            .snapshot(session_id)
            .await?
            .agents
            .into_iter()
            .filter(|agent| agent.status.is_active())
            .map(|agent| agent.agent_id)
            .collect())
    }

    pub async fn wait_for_update(
        &self,
        session_id: &SessionId,
        recipient_context_scope_id: &str,
        targets: &[String],
        timeout: Duration,
    ) -> Result<AgentWaitResult, AppError> {
        let state = self.session_state(session_id);
        let notify = {
            let state = state.lock().await;
            Arc::clone(&state.notify)
        };
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = Arc::clone(&notify).notified_owned();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let mut guard = state.lock().await;
            self.ensure_loaded(session_id, &mut guard).await?;
            let mut next = loaded_snapshot(&guard)?;
            let recipient = resolve_context_parent(&next, recipient_context_scope_id)?.path;
            let authors = resolve_target_paths(&next, targets)?;
            let now = Utc::now();
            let mut messages = Vec::new();
            for message in &mut next.messages {
                if message.delivery_state == AgentMessageDeliveryState::Unread
                    && message.recipient == recipient
                    && authors
                        .as_ref()
                        .is_none_or(|authors| authors.contains(&message.author))
                {
                    message.delivery_state = AgentMessageDeliveryState::Read;
                    message.read_at = Some(now);
                    messages.push(message.clone());
                }
            }
            if !messages.is_empty() {
                bump_revision(&mut next)?;
                self.commit(&mut guard, next).await?;
                return Ok(AgentWaitResult {
                    messages,
                    outcome: AgentWaitOutcome::Updated,
                });
            }
            let has_active = next.agents.iter().any(|agent| {
                agent.status.is_active()
                    && authors
                        .as_ref()
                        .is_none_or(|authors| authors.contains(&agent.path))
            });
            if !has_active {
                return Ok(AgentWaitResult {
                    messages: Vec::new(),
                    outcome: AgentWaitOutcome::NoActiveAgents,
                });
            }
            drop(guard);
            if timeout.is_zero() {
                return Ok(AgentWaitResult {
                    messages: Vec::new(),
                    outcome: AgentWaitOutcome::Timeout,
                });
            }
            if tokio::time::timeout_at(deadline, &mut notified)
                .await
                .is_err()
            {
                return Ok(AgentWaitResult {
                    messages: Vec::new(),
                    outcome: AgentWaitOutcome::Timeout,
                });
            }
        }
    }

    pub async fn interrupt(&self, session_id: &SessionId, target: &str) -> Result<bool, AppError> {
        let snapshot = self.snapshot(session_id).await?;
        let agent = &snapshot.agents[resolve_agent_index(&snapshot, target)?];
        let descendant_prefix = format!("{}/", agent.path);
        let active = self.active.lock().await;
        let mut interrupted = false;
        for record in snapshot.agents.iter().filter(|record| {
            record.path == agent.path || record.path.starts_with(&descendant_prefix)
        }) {
            if let Some(attempt) = active
                .attempts
                .get(&(session_id.clone(), record.agent_id.clone()))
                && attempt.attempt_id == record.attempt_id
            {
                attempt.cancellation.cancel();
                interrupted = true;
            }
        }
        Ok(interrupted)
    }

    pub async fn cleanup_session(&self, session_id: &SessionId) -> Result<(), AppError> {
        {
            let mut active = self.active.lock().await;
            active.deleting_sessions.insert(session_id.clone());
            for ((owner_session, _), attempt) in &active.attempts {
                if owner_session == session_id {
                    attempt.cancellation.cancel();
                }
            }
        }
        self.wait_for_session_idle(session_id, CLEANUP_WAIT).await?;
        let state = self.session_state(session_id);
        let mut state = state.lock().await;
        self.persistence.remove(&self.path_for(session_id)).await?;
        state.snapshot = Some(AgentRuntimeSnapshot::empty(session_id.clone()));
        state.notify.notify_waiters();
        Ok(())
    }

    async fn wait_for_session_idle(
        &self,
        session_id: &SessionId,
        timeout: Duration,
    ) -> Result<(), AppError> {
        let state = self.session_state(session_id);
        let wait = async {
            loop {
                let notified = {
                    let guard = state.lock().await;
                    Arc::clone(&guard.notify).notified_owned()
                };
                if !self
                    .active
                    .lock()
                    .await
                    .attempts
                    .keys()
                    .any(|(owner_session, _)| owner_session == session_id)
                {
                    return;
                }
                notified.await;
            }
        };
        tokio::time::timeout(timeout, wait).await.map_err(|_| {
            AppError::run_active("Agent attempts did not stop before session cleanup timed out")
        })?;
        Ok(())
    }

    fn start_attempt(
        self: &Arc<Self>,
        record: AgentRecord,
        task: String,
        workspace_root: WorkspaceRoot,
        cancellation: CancellationToken,
    ) {
        let runtime = Arc::clone(self);
        self.tracker.spawn(async move {
            runtime
                .run_attempt(record, task, workspace_root, cancellation)
                .await;
        });
    }

    async fn run_attempt(
        self: Arc<Self>,
        record: AgentRecord,
        task: String,
        workspace_root: WorkspaceRoot,
        cancellation: CancellationToken,
    ) {
        let request = match self.mark_running(&record, task, workspace_root).await {
            Ok(Some(request)) => request,
            Ok(None) => {
                self.release_active(&record.session_id, &record.agent_id, &record.attempt_id)
                    .await;
                return;
            }
            Err(error) => {
                tracing::error!(diagnostic = %error, "agent attempt could not enter running state");
                self.release_active_for_record(&record).await;
                return;
            }
        };
        let execution =
            std::panic::AssertUnwindSafe(self.executor.execute(request, cancellation.clone()))
                .catch_unwind()
                .await;
        let (status, result) = match execution {
            Ok(Ok(output)) if !cancellation.is_cancelled() => (
                AgentRuntimeStatus::Completed,
                AgentTerminalResult {
                    status: AgentRuntimeStatus::Completed,
                    report: output.report,
                    conclusion: output.conclusion,
                },
            ),
            Ok(Ok(output)) => (
                AgentRuntimeStatus::Interrupted,
                AgentTerminalResult {
                    status: AgentRuntimeStatus::Interrupted,
                    report: output.report,
                    conclusion: output.conclusion,
                },
            ),
            Ok(Err(error)) => {
                let status = if cancellation.is_cancelled() {
                    AgentRuntimeStatus::Interrupted
                } else {
                    AgentRuntimeStatus::Failed
                };
                (
                    status,
                    AgentTerminalResult {
                        status,
                        report: format!("## SubAgent {status:?}\n\n{}", error.public_message()),
                        conclusion: Some("The SubAgent did not complete successfully.".to_string()),
                    },
                )
            }
            Err(_) => (
                AgentRuntimeStatus::Failed,
                AgentTerminalResult {
                    status: AgentRuntimeStatus::Failed,
                    report: "## SubAgent failed\n\nThe supervised Agent attempt panicked."
                        .to_string(),
                    conclusion: Some("The SubAgent did not complete successfully.".to_string()),
                },
            ),
        };
        if let Err(error) = self.commit_terminal(&record, status, result).await {
            tracing::error!(diagnostic = %error, "agent terminal snapshot could not be persisted");
        }
        self.release_active_for_record(&record).await;
    }

    async fn mark_running(
        &self,
        record: &AgentRecord,
        task: String,
        workspace_root: WorkspaceRoot,
    ) -> Result<Option<AgentAttemptRequest>, AppError> {
        let session_id = record.session_id.clone();
        let state = self.session_state(&session_id);
        let mut state = state.lock().await;
        self.ensure_loaded(&session_id, &mut state).await?;
        let mut next = loaded_snapshot(&state)?;
        let Some(agent) = next.agents.iter_mut().find(|agent| {
            agent.agent_id == record.agent_id
                && agent.attempt_id == record.attempt_id
                && agent.status == AgentRuntimeStatus::Queued
        }) else {
            return Ok(None);
        };
        let now = Utc::now();
        agent.status = AgentRuntimeStatus::Running;
        agent.started_at = Some(now);
        agent.updated_at = now;
        let agent = agent.clone();
        let mut mailbox_messages = Vec::new();
        for message in &mut next.messages {
            if message.recipient == agent.path
                && message.delivery_state == AgentMessageDeliveryState::Unread
            {
                message.delivery_state = AgentMessageDeliveryState::Read;
                message.read_at = Some(now);
                mailbox_messages.push(message.clone());
            }
        }
        bump_revision(&mut next)?;
        self.commit(&mut state, next).await?;
        Ok(Some(AgentAttemptRequest {
            session_id,
            workspace_root,
            agent,
            task,
            mailbox_messages,
        }))
    }

    async fn commit_terminal(
        &self,
        record: &AgentRecord,
        status: AgentRuntimeStatus,
        result: AgentTerminalResult,
    ) -> Result<bool, AppError> {
        let session_id = record.session_id.clone();
        let state = self.session_state(&session_id);
        let mut state = state.lock().await;
        self.ensure_loaded(&session_id, &mut state).await?;
        let mut next = loaded_snapshot(&state)?;
        let Some(index) = next.agents.iter().position(|agent| {
            agent.agent_id == record.agent_id
                && agent.attempt_id == record.attempt_id
                && agent.status.is_active()
        }) else {
            return Ok(false);
        };
        let now = Utc::now();
        let (path, parent_path, attempt_id) = {
            let agent = &mut next.agents[index];
            agent.status = status;
            agent.updated_at = now;
            agent.completed_at = Some(now);
            agent.result = Some(result.clone());
            (
                agent.path.clone(),
                agent.parent_path.clone(),
                agent.attempt_id.clone(),
            )
        };
        if !has_final_answer(&next, &attempt_id) {
            if next.messages.len() >= MAX_MESSAGES_PER_SESSION {
                return Err(AppError::storage(
                    "The agent mailbox cannot record a terminal result",
                    "terminal mailbox reserve was exhausted",
                    false,
                ));
            }
            next.messages.push(AgentMailboxMessage {
                message_id: new_identifier("amsg"),
                message_type: AgentMessageType::FinalAnswer,
                attempt_id,
                author: path,
                recipient: parent_path,
                payload: result.report,
                delivery_state: AgentMessageDeliveryState::Unread,
                created_at: now,
                read_at: None,
            });
        }
        bump_revision(&mut next)?;
        self.commit(&mut state, next).await?;
        Ok(true)
    }

    async fn reserve_attempt(
        &self,
        session_id: &SessionId,
        record: &AgentRecord,
        parent_cancellation: CancellationToken,
        parent_agent_id: &str,
    ) -> Result<CancellationToken, AppError> {
        let mut active = self.active.lock().await;
        if active.deleting_sessions.contains(session_id) {
            return Err(AppError::run_active(
                "The session is being deleted and cannot start another Agent",
            ));
        }
        if active.attempts.len() >= self.max_active_attempts {
            return Err(AppError::conflict(
                "The maximum number of concurrent Agent attempts has been reached",
            ));
        }
        let cancellation = if parent_agent_id == ROOT_AGENT_PATH {
            parent_cancellation.child_token()
        } else {
            active
                .attempts
                .get(&(session_id.clone(), parent_agent_id.to_string()))
                .ok_or_else(|| AppError::conflict("The parent Agent is not running"))?
                .cancellation
                .child_token()
        };
        let key = (session_id.clone(), record.agent_id.clone());
        if active.attempts.contains_key(&key) {
            return Err(AppError::conflict(
                "The Agent already has an active attempt",
            ));
        }
        active.attempts.insert(
            key,
            ActiveAttempt {
                attempt_id: record.attempt_id.clone(),
                cancellation: cancellation.clone(),
            },
        );
        Ok(cancellation)
    }

    async fn release_active(&self, session_id: &SessionId, agent_id: &str, attempt_id: &str) {
        let removed = {
            let mut active = self.active.lock().await;
            let key = (session_id.clone(), agent_id.to_string());
            if active
                .attempts
                .get(&key)
                .is_some_and(|active| active.attempt_id == attempt_id)
            {
                active.attempts.remove(&key);
                true
            } else {
                false
            }
        };
        if removed {
            self.session_state(session_id)
                .lock()
                .await
                .notify
                .notify_waiters();
        }
    }

    async fn release_active_for_record(&self, record: &AgentRecord) {
        self.release_active(&record.session_id, &record.agent_id, &record.attempt_id)
            .await;
    }

    async fn ensure_loaded(
        &self,
        session_id: &SessionId,
        state: &mut SessionAgentState,
    ) -> Result<(), AppError> {
        if state.snapshot.is_some() {
            return Ok(());
        }
        let path = self.path_for(session_id);
        let mut snapshot = match self.persistence.read(&path).await? {
            Some(bytes) => decode_snapshot(session_id, &path, &bytes)?,
            None => AgentRuntimeSnapshot::empty(session_id.clone()),
        };
        if recover_interrupted_attempts(&mut snapshot)? {
            bump_revision(&mut snapshot)?;
            self.persist_snapshot(&snapshot).await?;
            if let Err(error) = self.events.emit(&snapshot) {
                tracing::warn!(diagnostic = ?error.diagnostic(), "agent recovery event could not be emitted");
            }
        }
        state.snapshot = Some(snapshot);
        Ok(())
    }

    async fn commit(
        &self,
        state: &mut SessionAgentState,
        snapshot: AgentRuntimeSnapshot,
    ) -> Result<AgentRuntimeSnapshot, AppError> {
        self.persist_snapshot(&snapshot).await?;
        state.snapshot = Some(snapshot.clone());
        state.notify.notify_waiters();
        if let Err(error) = self.events.emit(&snapshot) {
            tracing::warn!(diagnostic = ?error.diagnostic(), "agent runtime event could not be emitted");
        }
        Ok(snapshot)
    }

    async fn persist_snapshot(&self, snapshot: &AgentRuntimeSnapshot) -> Result<(), AppError> {
        let bytes = serde_json::to_vec_pretty(snapshot).map_err(|source| {
            AppError::internal(format!("serialize agent runtime snapshot: {source}"))
        })?;
        if bytes.len() > MAX_AGENT_DOCUMENT_BYTES {
            return Err(AppError::validation(
                "The agent runtime snapshot is too large",
            ));
        }
        self.persistence
            .replace(&self.path_for(&snapshot.session_id), &bytes)
            .await
    }

    fn session_state(&self, session_id: &SessionId) -> Arc<Mutex<SessionAgentState>> {
        self.sessions
            .entry(session_id.clone())
            .or_insert_with(|| Arc::new(Mutex::new(SessionAgentState::default())))
            .clone()
    }

    fn path_for(&self, session_id: &SessionId) -> PathBuf {
        self.root.join(format!("{}.json", session_id.as_str()))
    }

    fn ensure_accepting(&self) -> Result<(), AppError> {
        if self.accepting.load(Ordering::Acquire) && !self.tracker.is_closed() {
            Ok(())
        } else {
            Err(AppError::cancelled(
                "The Agent runtime is shutting down and is not accepting work",
            ))
        }
    }

    async fn cancel_all(&self) {
        for attempt in self.active.lock().await.attempts.values() {
            attempt.cancellation.cancel();
        }
    }
}

impl ShutdownHook for AgentRuntime {
    fn name(&self) -> &'static str {
        "agent-runtime"
    }

    fn run(&self, phase: ShutdownPhase) -> ShutdownFuture<'_> {
        Box::pin(async move {
            match phase {
                ShutdownPhase::StopAccepting => {
                    self.accepting.store(false, Ordering::Release);
                    self.tracker.close();
                }
                ShutdownPhase::Cancel | ShutdownPhase::ForceCleanup => self.cancel_all().await,
                ShutdownPhase::Flush => self.tracker.wait().await,
            }
            Ok(())
        })
    }
}

#[derive(Clone)]
struct ContextParent {
    agent_id: String,
    path: String,
}

impl ContextParent {
    fn root() -> Self {
        Self {
            agent_id: ROOT_AGENT_PATH.to_string(),
            path: ROOT_AGENT_PATH.to_string(),
        }
    }
}

fn loaded_snapshot(state: &SessionAgentState) -> Result<AgentRuntimeSnapshot, AppError> {
    state
        .snapshot
        .clone()
        .ok_or_else(|| AppError::internal("agent runtime snapshot was not loaded"))
}

fn resolve_context_parent(
    snapshot: &AgentRuntimeSnapshot,
    context_scope_id: &str,
) -> Result<ContextParent, AppError> {
    if context_scope_id == MAIN_CONTEXT_SCOPE {
        return Ok(ContextParent::root());
    }
    let agent_id = context_scope_id
        .strip_prefix("subagent:")
        .ok_or_else(|| AppError::not_found("The Agent context was not found"))?;
    snapshot
        .agents
        .iter()
        .find(|agent| agent.agent_id == agent_id)
        .map(|agent| ContextParent {
            agent_id: agent.agent_id.clone(),
            path: agent.path.clone(),
        })
        .ok_or_else(|| AppError::not_found("The Agent context was not found"))
}

fn resolve_agent_index(snapshot: &AgentRuntimeSnapshot, target: &str) -> Result<usize, AppError> {
    snapshot
        .agents
        .iter()
        .position(|agent| agent.agent_id == target || agent.path == target)
        .ok_or_else(|| AppError::not_found("The agent target was not found"))
}

fn resolve_target_paths(
    snapshot: &AgentRuntimeSnapshot,
    targets: &[String],
) -> Result<Option<HashSet<String>>, AppError> {
    if targets.is_empty() {
        return Ok(None);
    }
    targets
        .iter()
        .map(|target| {
            resolve_agent_index(snapshot, target).map(|index| snapshot.agents[index].path.clone())
        })
        .collect::<Result<HashSet<_>, _>>()
        .map(Some)
}

fn attempt_for_message(
    snapshot: &AgentRuntimeSnapshot,
    sender: &ContextParent,
    recipient: &ContextParent,
) -> Result<String, AppError> {
    [recipient, sender]
        .into_iter()
        .filter(|endpoint| endpoint.agent_id != ROOT_AGENT_PATH)
        .find_map(|endpoint| {
            snapshot
                .agents
                .iter()
                .find(|agent| agent.agent_id == endpoint.agent_id)
                .map(|agent| agent.attempt_id.clone())
        })
        .ok_or_else(|| AppError::validation("Agent messages require at least one Agent endpoint"))
}

fn validate_spawn_input(input: &SpawnAgentInput) -> Result<(), AppError> {
    if !matches!(input.role.as_str(), "Explore" | "Reviewer") || input.role.len() > MAX_ROLE_BYTES {
        return Err(AppError::validation("The sub-agent role is not available"));
    }
    validate_task_name(&input.task_name)?;
    if !input.description.trim().is_empty() {
        validate_message(
            "Agent description",
            &input.description,
            MAX_DESCRIPTION_BYTES,
        )?;
    }
    validate_message("Agent task", &input.message, MAX_MESSAGE_BYTES)?;
    validate_launch_policy(&input.launch)
}

fn validate_launch_policy(policy: &AgentLaunchPolicy) -> Result<(), AppError> {
    if let Some(context) = &policy.context {
        validate_message("Agent context", context, MAX_CONTEXT_BYTES)?;
    }
    if let Some(expectations) = &policy.expectations {
        validate_string_list("Agent questions", &expectations.questions)?;
        validate_string_list("Agent out-of-scope list", &expectations.out_of_scope)?;
    }
    if let Some(scope) = &policy.scope {
        validate_relative_paths("Agent scope directory", &scope.directories)?;
        validate_string_list("Agent exclude globs", &scope.exclude_globs)?;
    }
    validate_relative_paths("Agent allowed write file", &policy.allowed_write_files)
}

fn validate_task_name(value: &str) -> Result<(), AppError> {
    if value.is_empty()
        || value.len() > MAX_TASK_NAME_BYTES
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'_' | b'-'))
        })
    {
        return Err(AppError::validation(
            "Agent task names must use 1-64 ASCII letters, digits, underscores, or hyphens",
        ));
    }
    Ok(())
}

fn validate_message(field: &str, value: &str, maximum: usize) -> Result<(), AppError> {
    if value.trim().is_empty() || value.len() > maximum || value.contains('\0') {
        return Err(AppError::validation(format!(
            "{field} is invalid or too large"
        )));
    }
    Ok(())
}

fn validate_string_list(field: &str, values: &[String]) -> Result<(), AppError> {
    if values.len() > MAX_LIST_ITEMS {
        return Err(AppError::validation(format!("{field} is too large")));
    }
    for value in values {
        validate_message(field, value, MAX_LIST_ITEM_BYTES)?;
    }
    Ok(())
}

fn validate_relative_paths(field: &str, values: &[String]) -> Result<(), AppError> {
    validate_string_list(field, values)?;
    for value in values {
        let path = Path::new(value);
        if path.is_absolute()
            || path.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(AppError::validation(format!(
                "{field} must be a relative workspace path"
            )));
        }
    }
    Ok(())
}

fn normalized_description(description: &str, message: &str) -> String {
    let value = if description.trim().is_empty() {
        message.trim()
    } else {
        description.trim()
    };
    truncate_utf8(value, MAX_DESCRIPTION_BYTES).to_string()
}

fn truncate_utf8(value: &str, maximum: usize) -> &str {
    if value.len() <= maximum {
        return value;
    }
    let mut end = maximum;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn new_identifier(prefix: &str) -> String {
    format!("{prefix}_{}", Uuid::new_v4())
}

fn bump_revision(snapshot: &mut AgentRuntimeSnapshot) -> Result<(), AppError> {
    snapshot.revision = snapshot.revision.checked_add(1).ok_or_else(|| {
        AppError::storage(
            "Agent runtime state cannot be updated",
            "agent runtime revision overflowed",
            false,
        )
    })?;
    Ok(())
}

fn ensure_general_message_capacity(snapshot: &mut AgentRuntimeSnapshot) -> Result<(), AppError> {
    while snapshot.messages.len() >= MAX_GENERAL_MESSAGES_PER_SESSION {
        let Some(index) = snapshot
            .messages
            .iter()
            .position(|message| message.delivery_state == AgentMessageDeliveryState::Read)
        else {
            return Err(AppError::conflict("The Agent mailbox is full"));
        };
        snapshot.messages.remove(index);
    }
    Ok(())
}

fn has_final_answer(snapshot: &AgentRuntimeSnapshot, attempt_id: &str) -> bool {
    snapshot.messages.iter().any(|message| {
        message.message_type == AgentMessageType::FinalAnswer && message.attempt_id == attempt_id
    })
}

fn recover_interrupted_attempts(snapshot: &mut AgentRuntimeSnapshot) -> Result<bool, AppError> {
    let active = snapshot
        .agents
        .iter()
        .enumerate()
        .filter(|(_, agent)| agent.status.is_active())
        .map(|(index, agent)| (index, agent.attempt_id.clone()))
        .collect::<Vec<_>>();
    if active.is_empty() {
        return Ok(false);
    }
    let now = Utc::now();
    for (index, attempt_id) in active {
        let (path, parent_path, report) = {
            let agent = &mut snapshot.agents[index];
            let report = "## SubAgent interrupted\n\nThe application restarted before this SubAgent completed.".to_string();
            agent.status = AgentRuntimeStatus::Interrupted;
            agent.updated_at = now;
            agent.completed_at = Some(now);
            agent.result = Some(AgentTerminalResult {
                status: AgentRuntimeStatus::Interrupted,
                report: report.clone(),
                conclusion: Some(
                    "Start a follow-up attempt to continue from durable context.".to_string(),
                ),
            });
            (agent.path.clone(), agent.parent_path.clone(), report)
        };
        if !has_final_answer(snapshot, &attempt_id) {
            if snapshot.messages.len() >= MAX_MESSAGES_PER_SESSION {
                return Err(AppError::storage(
                    "The Agent runtime could not recover its terminal mailbox",
                    "terminal mailbox reserve was exhausted during recovery",
                    false,
                ));
            }
            snapshot.messages.push(AgentMailboxMessage {
                message_id: new_identifier("amsg"),
                message_type: AgentMessageType::FinalAnswer,
                attempt_id,
                author: path,
                recipient: parent_path,
                payload: report,
                delivery_state: AgentMessageDeliveryState::Unread,
                created_at: now,
                read_at: None,
            });
        }
    }
    Ok(true)
}

fn decode_snapshot(
    expected_session_id: &SessionId,
    path: &Path,
    bytes: &[u8],
) -> Result<AgentRuntimeSnapshot, AppError> {
    if bytes.len() > MAX_AGENT_DOCUMENT_BYTES {
        return Err(agent_document_error(
            path,
            "document exceeds the byte limit",
        ));
    }
    let snapshot: AgentRuntimeSnapshot = serde_json::from_slice(bytes)
        .map_err(|source| agent_document_error(path, format!("parse JSON: {source}")))?;
    validate_snapshot(expected_session_id, path, &snapshot)?;
    Ok(snapshot)
}

fn validate_snapshot(
    expected_session_id: &SessionId,
    path: &Path,
    snapshot: &AgentRuntimeSnapshot,
) -> Result<(), AppError> {
    if snapshot.version != AGENT_RUNTIME_SNAPSHOT_VERSION
        || &snapshot.session_id != expected_session_id
        || snapshot.agents.len() > MAX_AGENTS_PER_SESSION
        || snapshot.messages.len() > MAX_MESSAGES_PER_SESSION
    {
        return Err(agent_document_error(
            path,
            "invalid snapshot identity or bounds",
        ));
    }
    if snapshot
        .agents
        .iter()
        .filter(|agent| agent.status.is_active())
        .count()
        > MAX_ACTIVE_ATTEMPTS
    {
        return Err(agent_document_error(path, "too many active Agent attempts"));
    }
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    let mut attempts = HashSet::new();
    for agent in &snapshot.agents {
        validate_record(path, agent)?;
        if agent.session_id != *expected_session_id {
            return Err(agent_document_error(
                path,
                "Agent session identity mismatch",
            ));
        }
        if !ids.insert(agent.agent_id.as_str())
            || !paths.insert(agent.path.as_str())
            || !attempts.insert(agent.attempt_id.as_str())
        {
            return Err(agent_document_error(path, "duplicate Agent identity"));
        }
    }
    for agent in &snapshot.agents {
        if agent.parent_agent_id == ROOT_AGENT_PATH {
            if agent.parent_path != ROOT_AGENT_PATH || !agent.path.starts_with("/root/") {
                return Err(agent_document_error(path, "invalid root Agent address"));
            }
        } else {
            let Some(parent) = snapshot
                .agents
                .iter()
                .find(|parent| parent.agent_id == agent.parent_agent_id)
            else {
                return Err(agent_document_error(path, "missing parent Agent"));
            };
            if parent.path != agent.parent_path
                || !agent.path.starts_with(&format!("{}/", parent.path))
            {
                return Err(agent_document_error(path, "invalid child Agent address"));
            }
        }
    }
    let mut message_ids = HashSet::new();
    let mut final_attempts = HashSet::new();
    for message in &snapshot.messages {
        validate_identifier(&message.message_id, "amsg")
            .map_err(|error| agent_document_error(path, error.public_message()))?;
        validate_identifier(&message.attempt_id, "attempt")
            .map_err(|error| agent_document_error(path, error.public_message()))?;
        validate_message("Agent mailbox payload", &message.payload, MAX_MESSAGE_BYTES)
            .map_err(|error| agent_document_error(path, error.public_message()))?;
        if !message_ids.insert(message.message_id.as_str()) {
            return Err(agent_document_error(
                path,
                "duplicate mailbox message identity",
            ));
        }
        if !endpoint_exists(snapshot, &message.author)
            || !endpoint_exists(snapshot, &message.recipient)
        {
            return Err(agent_document_error(
                path,
                "mailbox endpoint is not registered",
            ));
        }
        if message.delivery_state == AgentMessageDeliveryState::Read && message.read_at.is_none()
            || message.delivery_state == AgentMessageDeliveryState::Unread
                && message.read_at.is_some()
        {
            return Err(agent_document_error(path, "invalid mailbox delivery state"));
        }
        if message.message_type == AgentMessageType::FinalAnswer
            && !final_attempts.insert(message.attempt_id.as_str())
        {
            return Err(agent_document_error(path, "duplicate FINAL_ANSWER"));
        }
    }
    Ok(())
}

fn validate_record(path: &Path, agent: &AgentRecord) -> Result<(), AppError> {
    validate_identifier(&agent.agent_id, "agent")
        .map_err(|error| agent_document_error(path, error.public_message()))?;
    validate_identifier(&agent.attempt_id, "attempt")
        .map_err(|error| agent_document_error(path, error.public_message()))?;
    validate_task_name(&agent.task_name)
        .map_err(|error| agent_document_error(path, error.public_message()))?;
    validate_message("Agent role", &agent.role, MAX_ROLE_BYTES)
        .map_err(|error| agent_document_error(path, error.public_message()))?;
    validate_message(
        "Agent description",
        &agent.description,
        MAX_DESCRIPTION_BYTES,
    )
    .map_err(|error| agent_document_error(path, error.public_message()))?;
    validate_launch_policy(&agent.launch)
        .map_err(|error| agent_document_error(path, error.public_message()))?;
    if agent.run_count == 0 || agent.context_scope_id != format!("subagent:{}", agent.agent_id) {
        return Err(agent_document_error(path, "invalid Agent runtime identity"));
    }
    if agent.status.is_terminal() && (agent.result.is_none() || agent.completed_at.is_none())
        || agent.status.is_active() && (agent.result.is_some() || agent.completed_at.is_some())
    {
        return Err(agent_document_error(path, "invalid Agent terminal state"));
    }
    if let Some(result) = &agent.result
        && (result.status != agent.status || !result.status.is_terminal())
    {
        return Err(agent_document_error(path, "Agent result status mismatch"));
    }
    Ok(())
}

fn validate_identifier(value: &str, prefix: &str) -> Result<(), AppError> {
    let uuid = value
        .strip_prefix(&format!("{prefix}_"))
        .ok_or_else(|| AppError::validation("Invalid Agent runtime identifier"))?;
    Uuid::parse_str(uuid)
        .map(|_| ())
        .map_err(|_| AppError::validation("Invalid Agent runtime identifier"))
}

fn endpoint_exists(snapshot: &AgentRuntimeSnapshot, endpoint: &str) -> bool {
    endpoint == ROOT_AGENT_PATH || snapshot.agents.iter().any(|agent| agent.path == endpoint)
}

fn agent_document_error(path: &Path, diagnostic: impl std::fmt::Display) -> AppError {
    AppError::storage(
        "The saved Agent runtime state is invalid",
        format!("agent runtime document {}: {diagnostic}", path.display()),
        false,
    )
}

fn agent_directory_error(path: &Path, diagnostic: impl std::fmt::Display) -> AppError {
    AppError::storage(
        "The Agent runtime storage is invalid",
        format!("Agent runtime storage {}: {diagnostic}", path.display()),
        false,
    )
}

#[cfg(windows)]
fn is_agent_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_agent_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use async_trait::async_trait;
    use codez_core::{
        AppError, AppErrorKind, AtomicPersistence, CancellationToken, SessionId, WorkspaceRoot,
    };
    use codez_storage::AtomicFileStore;
    use tokio::sync::{Notify, Semaphore};

    use super::{
        AGENT_RUNTIME_SNAPSHOT_VERSION, AgentAttemptExecutor, AgentAttemptOutput,
        AgentAttemptRequest, AgentLaunchPolicy, AgentMailboxMessage, AgentMessageDeliveryState,
        AgentMessageType, AgentRecord, AgentRuntime, AgentRuntimeSnapshot, AgentRuntimeStatus,
        AgentTerminalResult, AgentWaitOutcome, SpawnAgentInput, bump_revision, new_identifier,
    };

    struct ImmediateExecutor;

    #[async_trait]
    impl AgentAttemptExecutor for ImmediateExecutor {
        async fn execute(
            &self,
            request: AgentAttemptRequest,
            _cancellation: CancellationToken,
        ) -> Result<AgentAttemptOutput, AppError> {
            Ok(AgentAttemptOutput {
                report: format!("completed {}", request.task),
                conclusion: Some("done".to_string()),
            })
        }
    }

    struct BlockingExecutor {
        started: Arc<Semaphore>,
        release: Arc<Notify>,
    }

    impl BlockingExecutor {
        fn new() -> Self {
            Self {
                started: Arc::new(Semaphore::new(0)),
                release: Arc::new(Notify::new()),
            }
        }

        async fn wait_started(&self) {
            self.started
                .acquire()
                .await
                .expect("test executor semaphore must remain open")
                .forget();
        }
    }

    struct ParentCompletionExecutor {
        started: Arc<Semaphore>,
        complete_parent: Arc<Notify>,
    }

    impl ParentCompletionExecutor {
        fn new() -> Self {
            Self {
                started: Arc::new(Semaphore::new(0)),
                complete_parent: Arc::new(Notify::new()),
            }
        }

        async fn wait_started(&self) {
            self.started
                .acquire()
                .await
                .expect("test executor semaphore must remain open")
                .forget();
        }
    }

    #[async_trait]
    impl AgentAttemptExecutor for ParentCompletionExecutor {
        async fn execute(
            &self,
            request: AgentAttemptRequest,
            cancellation: CancellationToken,
        ) -> Result<AgentAttemptOutput, AppError> {
            self.started.add_permits(1);
            if request.agent.task_name == "parent" {
                tokio::select! {
                    () = cancellation.cancelled() => {
                        Err(AppError::cancelled("test parent was interrupted"))
                    }
                    () = self.complete_parent.notified() => {
                        Ok(AgentAttemptOutput {
                            report: "parent completed".to_string(),
                            conclusion: None,
                        })
                    }
                }
            } else {
                cancellation.cancelled().await;
                Err(AppError::cancelled("test child was interrupted"))
            }
        }
    }

    #[async_trait]
    impl AgentAttemptExecutor for BlockingExecutor {
        async fn execute(
            &self,
            _request: AgentAttemptRequest,
            cancellation: CancellationToken,
        ) -> Result<AgentAttemptOutput, AppError> {
            self.started.add_permits(1);
            tokio::select! {
                () = cancellation.cancelled() => {
                    Err(AppError::cancelled("test Agent was interrupted"))
                }
                () = self.release.notified() => {
                    Ok(AgentAttemptOutput {
                        report: "released".to_string(),
                        conclusion: None,
                    })
                }
            }
        }
    }

    fn session(value: &str) -> SessionId {
        SessionId::parse(value).expect("test session ID must be valid")
    }

    fn spawn_input(task_name: &str, parent_context_scope_id: &str) -> SpawnAgentInput {
        SpawnAgentInput {
            workspace_root: workspace_root(),
            parent_context_scope_id: parent_context_scope_id.to_string(),
            role: "Explore".to_string(),
            task_name: task_name.to_string(),
            description: format!("Explore {task_name}"),
            message: format!("Inspect {task_name}"),
            launch: AgentLaunchPolicy::default(),
        }
    }

    fn workspace_root() -> WorkspaceRoot {
        let path =
            std::fs::canonicalize(std::env::current_dir().expect("current directory must exist"))
                .expect("current directory must canonicalize");
        WorkspaceRoot::from_canonical(path).expect("test workspace root must be valid")
    }

    fn persistence() -> Arc<dyn AtomicPersistence> {
        Arc::new(AtomicFileStore::default())
    }

    #[tokio::test]
    async fn terminal_result_and_final_answer_commit_in_one_snapshot() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let runtime = Arc::new(AgentRuntime::new(
            directory.path(),
            persistence(),
            Arc::new(ImmediateExecutor),
        ));
        let session_id = session("session-1");
        let record = runtime
            .spawn(
                &session_id,
                spawn_input("terminal", "main"),
                CancellationToken::new(),
            )
            .await
            .expect("Agent spawn must succeed");

        let result = runtime
            .wait_for_update(
                &session_id,
                "main",
                std::slice::from_ref(&record.agent_id),
                Duration::from_secs(2),
            )
            .await
            .expect("root mailbox wait must succeed");
        let snapshot = runtime
            .snapshot(&session_id)
            .await
            .expect("terminal snapshot must load");
        let terminal = &snapshot.agents[0];
        let finals = snapshot
            .messages
            .iter()
            .filter(|message| message.message_type == AgentMessageType::FinalAnswer)
            .count();

        assert_eq!(
            (
                result.outcome,
                terminal.status,
                terminal.result.as_ref().map(|value| value.status),
                finals,
            ),
            (
                AgentWaitOutcome::Updated,
                AgentRuntimeStatus::Completed,
                Some(AgentRuntimeStatus::Completed),
                1,
            )
        );
    }

    #[tokio::test]
    async fn completed_followup_snapshot_remains_loadable_after_restart() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let persistence = persistence();
        let runtime = Arc::new(AgentRuntime::new(
            directory.path(),
            Arc::clone(&persistence),
            Arc::new(ImmediateExecutor),
        ));
        let session_id = session("session-followup-restart");
        let first = runtime
            .spawn(
                &session_id,
                spawn_input("followup", "main"),
                CancellationToken::new(),
            )
            .await
            .expect("initial Agent spawn must succeed");
        runtime
            .wait_for_update(
                &session_id,
                "main",
                std::slice::from_ref(&first.agent_id),
                Duration::from_secs(2),
            )
            .await
            .expect("initial Agent completion must be observable");
        let second = runtime
            .followup(
                &session_id,
                "main",
                &first.agent_id,
                "Inspect the follow-up state".to_string(),
                workspace_root(),
                CancellationToken::new(),
            )
            .await
            .expect("follow-up Agent attempt must start");
        runtime
            .wait_for_update(
                &session_id,
                "main",
                std::slice::from_ref(&second.agent_id),
                Duration::from_secs(2),
            )
            .await
            .expect("follow-up Agent completion must be observable");
        drop(runtime);

        let snapshot =
            AgentRuntime::new(directory.path(), persistence, Arc::new(ImmediateExecutor))
                .snapshot(&session_id)
                .await
                .expect("completed follow-up snapshot must survive restart validation");

        assert_eq!(
            (
                snapshot.agents[0].status,
                snapshot.agents[0].run_count,
                snapshot
                    .messages
                    .iter()
                    .filter(|message| message.message_type == AgentMessageType::FinalAnswer)
                    .count(),
            ),
            (AgentRuntimeStatus::Completed, 2, 2)
        );
    }

    #[tokio::test]
    async fn concurrent_admission_enforces_the_limit_in_one_critical_section() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let executor = Arc::new(BlockingExecutor::new());
        let runtime = Arc::new(AgentRuntime::with_limit(
            directory.path(),
            persistence(),
            executor.clone(),
            Arc::new(super::NoopAgentRuntimeEventSink),
            2,
        ));
        let session_id = session("session-1");
        let root = CancellationToken::new();
        runtime
            .spawn(&session_id, spawn_input("first", "main"), root.clone())
            .await
            .expect("first Agent must be admitted");
        runtime
            .spawn(&session_id, spawn_input("second", "main"), root.clone())
            .await
            .expect("second Agent must be admitted");
        executor.wait_started().await;
        executor.wait_started().await;

        let error = runtime
            .spawn(&session_id, spawn_input("third", "main"), root)
            .await
            .expect_err("third Agent must exceed the shared admission limit");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
        runtime
            .cleanup_session(&session_id)
            .await
            .expect("cleanup must cancel both blocked Agents");
    }

    #[tokio::test]
    async fn cleanup_waits_for_supervision_and_removes_the_session_snapshot() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let persistence = persistence();
        let executor = Arc::new(BlockingExecutor::new());
        let runtime = Arc::new(AgentRuntime::new(
            directory.path(),
            Arc::clone(&persistence),
            executor.clone(),
        ));
        let session_id = session("session-cleanup");
        runtime
            .spawn(
                &session_id,
                spawn_input("cleanup", "main"),
                CancellationToken::new(),
            )
            .await
            .expect("cleanup fixture Agent must start");
        executor.wait_started().await;

        runtime
            .cleanup_session(&session_id)
            .await
            .expect("cleanup must cancel, join, and remove the Agent snapshot");
        let persisted = persistence
            .read(&directory.path().join("agent-runtime/session-cleanup.json"))
            .await
            .expect("cleanup path inspection must succeed");
        let snapshot = runtime
            .snapshot(&session_id)
            .await
            .expect("cleaned in-memory snapshot must remain readable");
        let error = runtime
            .spawn(
                &session_id,
                spawn_input("late", "main"),
                CancellationToken::new(),
            )
            .await
            .expect_err("deleting session must reject late Agent admission");

        assert!(
            persisted.is_none()
                && snapshot.agents.is_empty()
                && error.kind() == AppErrorKind::RunActive
        );
    }

    #[tokio::test]
    async fn wait_observes_a_message_posted_after_registration_without_lost_wakeup() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let executor = Arc::new(BlockingExecutor::new());
        let runtime = Arc::new(AgentRuntime::new(
            directory.path(),
            persistence(),
            executor.clone(),
        ));
        let session_id = session("session-1");
        let record = runtime
            .spawn(
                &session_id,
                spawn_input("message", "main"),
                CancellationToken::new(),
            )
            .await
            .expect("Agent spawn must succeed");
        executor.wait_started().await;
        let waiting = {
            let runtime = Arc::clone(&runtime);
            let session_id = session_id.clone();
            let target = record.agent_id.clone();
            tokio::spawn(async move {
                runtime
                    .wait_for_update(&session_id, "main", &[target], Duration::from_secs(2))
                    .await
            })
        };
        tokio::task::yield_now().await;

        runtime
            .send_message(
                &session_id,
                &record.context_scope_id,
                "/root",
                "progress update".to_string(),
            )
            .await
            .expect("Agent message must persist");
        let result = waiting
            .await
            .expect("wait task must join")
            .expect("wait must succeed");

        assert!(
            result.outcome == AgentWaitOutcome::Updated
                && result.messages[0].payload == "progress update"
        );
        runtime
            .cleanup_session(&session_id)
            .await
            .expect("cleanup must cancel the blocked Agent");
    }

    #[tokio::test]
    async fn interrupting_a_parent_cancels_its_descendant_attempt() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let executor = Arc::new(BlockingExecutor::new());
        let runtime = Arc::new(AgentRuntime::new(
            directory.path(),
            persistence(),
            executor.clone(),
        ));
        let session_id = session("session-1");
        let parent = runtime
            .spawn(
                &session_id,
                spawn_input("parent", "main"),
                CancellationToken::new(),
            )
            .await
            .expect("parent Agent must start");
        executor.wait_started().await;
        let child = runtime
            .spawn(
                &session_id,
                spawn_input("child", &parent.context_scope_id),
                CancellationToken::new(),
            )
            .await
            .expect("child Agent must derive cancellation from its parent");
        executor.wait_started().await;

        assert!(
            runtime
                .interrupt(&session_id, &parent.agent_id)
                .await
                .expect("parent interrupt must resolve")
        );
        runtime
            .wait_for_session_idle(&session_id, Duration::from_secs(2))
            .await
            .expect("parent and child must both terminate");
        let snapshot = runtime
            .snapshot(&session_id)
            .await
            .expect("interrupted snapshot must load");
        let statuses = snapshot
            .agents
            .iter()
            .filter(|agent| agent.agent_id == parent.agent_id || agent.agent_id == child.agent_id)
            .map(|agent| agent.status)
            .collect::<Vec<_>>();

        assert_eq!(
            statuses,
            [
                AgentRuntimeStatus::Interrupted,
                AgentRuntimeStatus::Interrupted
            ]
        );
    }

    #[tokio::test]
    async fn agent_targets_are_not_resolved_across_sessions() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let runtime = Arc::new(AgentRuntime::new(
            directory.path(),
            persistence(),
            Arc::new(ImmediateExecutor),
        ));
        let owner_session = session("session-owner");
        let other_session = session("session-other");
        let record = runtime
            .spawn(
                &owner_session,
                spawn_input("owned", "main"),
                CancellationToken::new(),
            )
            .await
            .expect("owner Agent must start");

        let error = runtime
            .interrupt(&other_session, &record.agent_id)
            .await
            .expect_err("another session must not resolve the Agent ID");

        assert_eq!(error.kind(), AppErrorKind::NotFound);
    }

    #[tokio::test]
    async fn followup_conflicts_until_the_cancelled_attempt_becomes_terminal() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let executor = Arc::new(BlockingExecutor::new());
        let runtime = Arc::new(AgentRuntime::new(
            directory.path(),
            persistence(),
            executor.clone(),
        ));
        let session_id = session("session-cancel-followup");
        let record = runtime
            .spawn(
                &session_id,
                spawn_input("cancelled", "main"),
                CancellationToken::new(),
            )
            .await
            .expect("initial Agent must start");
        executor.wait_started().await;
        runtime
            .interrupt(&session_id, &record.agent_id)
            .await
            .expect("interrupt must resolve");
        let conflict = runtime
            .followup(
                &session_id,
                "main",
                &record.agent_id,
                "too early".to_string(),
                workspace_root(),
                CancellationToken::new(),
            )
            .await
            .expect_err("follow-up must not overlap the cancelled attempt");
        runtime
            .wait_for_session_idle(&session_id, Duration::from_secs(2))
            .await
            .expect("cancelled attempt must become terminal");
        let followup = runtime
            .followup(
                &session_id,
                "main",
                &record.agent_id,
                "continue after cancellation".to_string(),
                workspace_root(),
                CancellationToken::new(),
            )
            .await
            .expect("follow-up must start after terminal persistence");
        executor.wait_started().await;

        assert!(
            conflict.kind() == AppErrorKind::Conflict
                && followup.attempt_id != record.attempt_id
                && followup.run_count == 2
        );
        runtime
            .cleanup_session(&session_id)
            .await
            .expect("cleanup must stop the follow-up fixture");
    }

    #[tokio::test]
    async fn interrupting_a_terminal_parent_still_cancels_active_descendants() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let executor = Arc::new(ParentCompletionExecutor::new());
        let runtime = Arc::new(AgentRuntime::new(
            directory.path(),
            persistence(),
            executor.clone(),
        ));
        let session_id = session("session-terminal-parent");
        let parent = runtime
            .spawn(
                &session_id,
                spawn_input("parent", "main"),
                CancellationToken::new(),
            )
            .await
            .expect("parent Agent must start");
        executor.wait_started().await;
        let child = runtime
            .spawn(
                &session_id,
                spawn_input("child", &parent.context_scope_id),
                CancellationToken::new(),
            )
            .await
            .expect("child Agent must derive cancellation from its parent");
        executor.wait_started().await;
        executor.complete_parent.notify_one();
        runtime
            .wait_for_update(
                &session_id,
                "main",
                std::slice::from_ref(&parent.agent_id),
                Duration::from_secs(2),
            )
            .await
            .expect("parent completion must become observable");

        assert!(
            runtime
                .interrupt(&session_id, &parent.agent_id)
                .await
                .expect("terminal parent interrupt must resolve")
        );
        runtime
            .wait_for_session_idle(&session_id, Duration::from_secs(2))
            .await
            .expect("active descendant must stop");
        let snapshot = runtime
            .snapshot(&session_id)
            .await
            .expect("terminal parent snapshot must remain readable");
        let parent_status = snapshot
            .agents
            .iter()
            .find(|agent| agent.agent_id == parent.agent_id)
            .map(|agent| agent.status);
        let child_status = snapshot
            .agents
            .iter()
            .find(|agent| agent.agent_id == child.agent_id)
            .map(|agent| agent.status);

        assert_eq!(
            (parent_status, child_status),
            (
                Some(AgentRuntimeStatus::Completed),
                Some(AgentRuntimeStatus::Interrupted)
            )
        );
    }

    #[tokio::test]
    async fn stale_attempt_completion_cannot_overwrite_a_new_attempt_id() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let executor = Arc::new(BlockingExecutor::new());
        let runtime = Arc::new(AgentRuntime::new(
            directory.path(),
            persistence(),
            executor.clone(),
        ));
        let session_id = session("session-1");
        let record = runtime
            .spawn(
                &session_id,
                spawn_input("stale", "main"),
                CancellationToken::new(),
            )
            .await
            .expect("Agent spawn must succeed");
        executor.wait_started().await;
        let replacement_attempt = new_identifier("attempt");
        let state = runtime.session_state(&session_id);
        {
            let mut state = state.lock().await;
            let mut next = super::loaded_snapshot(&state).expect("snapshot must be loaded");
            next.agents[0].attempt_id.clone_from(&replacement_attempt);
            bump_revision(&mut next).expect("revision must advance");
            runtime
                .commit(&mut state, next)
                .await
                .expect("replacement attempt fixture must persist");
        }

        let applied = runtime
            .commit_terminal(
                &record,
                AgentRuntimeStatus::Completed,
                AgentTerminalResult {
                    status: AgentRuntimeStatus::Completed,
                    report: "stale".to_string(),
                    conclusion: None,
                },
            )
            .await
            .expect("stale completion check must succeed");
        let snapshot = runtime
            .snapshot(&session_id)
            .await
            .expect("snapshot must remain readable");

        assert_eq!(
            (
                applied,
                snapshot.agents[0].attempt_id.as_str(),
                snapshot.agents[0].status,
            ),
            (
                false,
                replacement_attempt.as_str(),
                AgentRuntimeStatus::Running,
            )
        );
        runtime
            .cleanup_session(&session_id)
            .await
            .expect("cleanup must release the stale executor");
    }

    #[tokio::test]
    async fn restart_recovery_interrupts_active_attempt_and_adds_one_final_answer() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let persistence = persistence();
        let session_id = session("session-recovery");
        let agent_id = "agent_00000000-0000-4000-8000-000000000001".to_string();
        let attempt_id = "attempt_00000000-0000-4000-8000-000000000002".to_string();
        let now = chrono::Utc::now();
        let snapshot = AgentRuntimeSnapshot {
            version: AGENT_RUNTIME_SNAPSHOT_VERSION,
            session_id: session_id.clone(),
            revision: 4,
            agents: vec![AgentRecord {
                agent_id: agent_id.clone(),
                session_id: session_id.clone(),
                parent_agent_id: "/root".to_string(),
                parent_path: "/root".to_string(),
                path: "/root/recovery".to_string(),
                role: "Explore".to_string(),
                task_name: "recovery".to_string(),
                description: "Recover Agent".to_string(),
                context_scope_id: format!("subagent:{agent_id}"),
                status: AgentRuntimeStatus::Queued,
                attempt_id: attempt_id.clone(),
                run_count: 1,
                created_at: now,
                updated_at: now,
                started_at: None,
                completed_at: None,
                launch: AgentLaunchPolicy::default(),
                result: None,
            }],
            messages: vec![AgentMailboxMessage {
                message_id: "amsg_00000000-0000-4000-8000-000000000003".to_string(),
                message_type: AgentMessageType::NewTask,
                attempt_id,
                author: "/root".to_string(),
                recipient: "/root/recovery".to_string(),
                payload: "Recover this task".to_string(),
                delivery_state: AgentMessageDeliveryState::Unread,
                created_at: now,
                read_at: None,
            }],
        };
        let path = directory.path().join("agent-runtime/session-recovery.json");
        persistence
            .replace(
                &path,
                &serde_json::to_vec(&snapshot).expect("fixture snapshot must serialize"),
            )
            .await
            .expect("fixture snapshot must persist");

        let first = AgentRuntime::new(
            directory.path(),
            Arc::clone(&persistence),
            Arc::new(ImmediateExecutor),
        )
        .snapshot(&session_id)
        .await
        .expect("first restart must recover");
        let second = AgentRuntime::new(directory.path(), persistence, Arc::new(ImmediateExecutor))
            .snapshot(&session_id)
            .await
            .expect("second restart must be idempotent");
        let final_count = second
            .messages
            .iter()
            .filter(|message| message.message_type == AgentMessageType::FinalAnswer)
            .count();

        assert_eq!(
            (
                first.agents[0].status,
                first.revision,
                second.revision,
                final_count,
            ),
            (AgentRuntimeStatus::Interrupted, 5, 5, 1)
        );
    }

    #[tokio::test]
    async fn startup_scan_recovers_active_snapshots_before_their_first_command() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let persistence = persistence();
        let session_id = session("session-startup-scan");
        let agent_id = "agent_00000000-0000-4000-8000-000000000011".to_string();
        let attempt_id = "attempt_00000000-0000-4000-8000-000000000012".to_string();
        let now = chrono::Utc::now();
        let snapshot = AgentRuntimeSnapshot {
            version: AGENT_RUNTIME_SNAPSHOT_VERSION,
            session_id: session_id.clone(),
            revision: 8,
            agents: vec![AgentRecord {
                agent_id: agent_id.clone(),
                session_id: session_id.clone(),
                parent_agent_id: "/root".to_string(),
                parent_path: "/root".to_string(),
                path: "/root/startup".to_string(),
                role: "Explore".to_string(),
                task_name: "startup".to_string(),
                description: "Recover at startup".to_string(),
                context_scope_id: format!("subagent:{agent_id}"),
                status: AgentRuntimeStatus::Running,
                attempt_id: attempt_id.clone(),
                run_count: 1,
                created_at: now,
                updated_at: now,
                started_at: Some(now),
                completed_at: None,
                launch: AgentLaunchPolicy::default(),
                result: None,
            }],
            messages: vec![AgentMailboxMessage {
                message_id: "amsg_00000000-0000-4000-8000-000000000013".to_string(),
                message_type: AgentMessageType::NewTask,
                attempt_id,
                author: "/root".to_string(),
                recipient: "/root/startup".to_string(),
                payload: "Recover before commands".to_string(),
                delivery_state: AgentMessageDeliveryState::Read,
                created_at: now,
                read_at: Some(now),
            }],
        };
        let path = directory
            .path()
            .join("agent-runtime/session-startup-scan.json");
        persistence
            .replace(
                &path,
                &serde_json::to_vec(&snapshot).expect("fixture snapshot must serialize"),
            )
            .await
            .expect("fixture snapshot must persist");
        let runtime = AgentRuntime::new(directory.path(), persistence, Arc::new(ImmediateExecutor));

        let recovered = runtime
            .recover_all()
            .await
            .expect("startup scan must recover the saved snapshot");

        assert_eq!(
            (
                recovered.len(),
                recovered[0].revision,
                recovered[0].agents[0].status,
            ),
            (1, 9, AgentRuntimeStatus::Interrupted)
        );
    }
}
