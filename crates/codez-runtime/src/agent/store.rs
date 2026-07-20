use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use codez_core::agent::{
    AgentAttempt, AgentBudget, AgentCompletionPolicy, AgentNode, AgentPolicy, AgentProfile,
    AgentResult, AgentState, AgentStateSnapshot, AgentStateTransitionError, AgentUsage,
    DelegatedTask, WorkspaceAssignment,
};
use codez_core::{AgentAttemptId, AgentId, AppError, AtomicPersistence, RootRunId};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::Mutex;

const CONTROL_EVENT_SCHEMA_VERSION: u16 = 1;
const CONTROL_LEDGER_FILE: &str = "control-events.jsonl";
const MAX_DISCOVERED_ROOTS: usize = 10_000;

#[derive(Debug, Error)]
pub enum AgentStoreError {
    #[error("agent control record could not be serialized")]
    Serialize(#[source] serde_json::Error),
    #[error("agent control ledger contains invalid JSON at line {line}")]
    InvalidJson {
        line: usize,
        #[source]
        source: serde_json::Error,
    },
    #[error("agent control ledger has unsupported schema version {0}")]
    UnsupportedSchema(u16),
    #[error("agent control event sequence is not contiguous: expected {expected}, found {actual}")]
    SequenceGap { expected: u64, actual: u64 },
    #[error("agent control event belongs to another root run")]
    RootMismatch,
    #[error("agent control event sequence overflowed")]
    SequenceOverflow,
    #[error("agent {0} was not found")]
    AgentNotFound(String),
    #[error("agent attempt {0} was not found")]
    AttemptNotFound(String),
    #[error("agent attempt does not belong to the selected agent")]
    AttemptAgentMismatch,
    #[error("agent result was already submitted with different content")]
    ResultConflict,
    #[error("agent control ledger contains an invalid event: {0}")]
    InvalidEvent(String),
    #[error(transparent)]
    StateTransition(#[from] AgentStateTransitionError),
    #[error(transparent)]
    Storage(#[from] AppError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHandle {
    pub agent_id: AgentId,
    pub attempt_id: AgentAttemptId,
    pub state: AgentState,
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRegistration {
    pub node: AgentNode,
    pub attempt: AgentAttempt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentTransitionRequest {
    pub root_run_id: RootRunId,
    pub agent_id: AgentId,
    pub attempt_id: AgentAttemptId,
    pub expected_revision: u64,
    pub next: AgentState,
    pub event_id: String,
    pub occurred_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAttemptRegistration {
    pub attempt: AgentAttempt,
    pub idempotency_key: Option<String>,
    pub task: DelegatedTask,
    pub profile: AgentProfile,
    pub policy: AgentPolicy,
    pub budget: AgentBudget,
    pub workspace: WorkspaceAssignment,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentControlEvent {
    pub schema_version: u16,
    pub event_id: String,
    pub root_run_id: RootRunId,
    pub sequence: u64,
    pub occurred_at: String,
    pub kind: AgentControlEventKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum AgentControlEventKind {
    RootRegistered {
        registration: Box<AgentRegistration>,
    },
    AgentsRegistered {
        parent_attempt_id: AgentAttemptId,
        tool_call_id: String,
        registrations: Vec<AgentRegistration>,
        #[serde(default)]
        completion_policy: AgentCompletionPolicy,
    },
    StateChanged {
        agent_id: AgentId,
        attempt_id: AgentAttemptId,
        previous: AgentState,
        next: AgentState,
        state_revision: u64,
    },
    ResultSubmitted {
        agent_id: AgentId,
        attempt_id: AgentAttemptId,
        result: Box<AgentResult>,
    },
    AttemptCreated {
        registration: Box<AgentAttemptRegistration>,
        node_state_revision: u64,
    },
    MailboxCursorAdvanced {
        attempt_id: AgentAttemptId,
        cursor: u64,
    },
    UsageRecorded {
        attempt_id: AgentAttemptId,
        usage: AgentUsage,
        #[serde(default)]
        remaining: Option<AgentBudget>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRootSnapshot {
    pub root_run_id: RootRunId,
    pub through_sequence: u64,
    pub nodes: HashMap<AgentId, AgentNode>,
    pub attempts: HashMap<AgentAttemptId, AgentAttempt>,
    pub results: HashMap<AgentAttemptId, AgentResult>,
    pub events: Vec<AgentControlEvent>,
    spawn_batches: HashMap<(AgentAttemptId, String), SpawnBatchRecord>,
    followup_attempts: HashMap<(AgentId, String), AgentHandle>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SpawnBatchRecord {
    handles: Vec<AgentHandle>,
    completion_policy: AgentCompletionPolicy,
}

impl AgentRootSnapshot {
    fn empty(root_run_id: RootRunId) -> Self {
        Self {
            root_run_id,
            through_sequence: 0,
            nodes: HashMap::new(),
            attempts: HashMap::new(),
            results: HashMap::new(),
            events: Vec::new(),
            spawn_batches: HashMap::new(),
            followup_attempts: HashMap::new(),
        }
    }

    #[must_use]
    pub fn root_agent(&self) -> Option<&AgentNode> {
        self.nodes.values().find(|node| node.parent_id.is_none())
    }

    #[must_use]
    pub fn children_of(&self, parent_id: &AgentId) -> Vec<&AgentNode> {
        self.nodes
            .values()
            .filter(|node| node.parent_id.as_ref() == Some(parent_id))
            .collect()
    }

    #[must_use]
    pub fn spawn_batch(
        &self,
        parent_attempt_id: &AgentAttemptId,
        tool_call_id: &str,
    ) -> Option<Vec<AgentHandle>> {
        self.spawn_batches
            .get(&(parent_attempt_id.clone(), tool_call_id.to_string()))
            .map(|batch| {
                batch
                    .handles
                    .iter()
                    .cloned()
                    .map(|mut handle| {
                        if let Some(node) = self.nodes.get(&handle.agent_id) {
                            handle.state = node.state;
                        }
                        handle
                    })
                    .collect()
            })
    }

    #[must_use]
    pub fn fail_fast_siblings(&self, agent_id: &AgentId) -> Vec<AgentId> {
        self.spawn_batches
            .values()
            .find(|batch| {
                batch.completion_policy == AgentCompletionPolicy::FailFast
                    && batch
                        .handles
                        .iter()
                        .any(|handle| handle.agent_id == *agent_id)
            })
            .map_or_else(Vec::new, |batch| {
                batch
                    .handles
                    .iter()
                    .filter(|handle| handle.agent_id != *agent_id)
                    .filter_map(|handle| self.nodes.get(&handle.agent_id))
                    .filter(|node| !node.state.is_terminal())
                    .map(|node| node.id.clone())
                    .collect()
            })
    }

    #[must_use]
    pub fn current_attempt(&self, agent_id: &AgentId) -> Option<&AgentAttempt> {
        self.attempts
            .values()
            .filter(|attempt| attempt.agent_id == *agent_id)
            .max_by_key(|attempt| attempt.ordinal)
    }

    #[must_use]
    pub fn followup_attempt(
        &self,
        agent_id: &AgentId,
        idempotency_key: &str,
    ) -> Option<AgentHandle> {
        self.followup_attempts
            .get(&(agent_id.clone(), idempotency_key.to_string()))
            .cloned()
    }

    fn apply(&mut self, event: AgentControlEvent) -> Result<(), AgentStoreError> {
        if event.root_run_id != self.root_run_id {
            return Err(AgentStoreError::RootMismatch);
        }
        let expected = self
            .through_sequence
            .checked_add(1)
            .ok_or(AgentStoreError::SequenceOverflow)?;
        if event.sequence != expected {
            return Err(AgentStoreError::SequenceGap {
                expected,
                actual: event.sequence,
            });
        }
        match &event.kind {
            AgentControlEventKind::RootRegistered { registration } => {
                self.apply_registration(registration)?;
            }
            AgentControlEventKind::AgentsRegistered {
                parent_attempt_id,
                tool_call_id,
                registrations,
                completion_policy,
            } => {
                let mut handles = Vec::with_capacity(registrations.len());
                for registration in registrations {
                    self.apply_registration(registration)?;
                    handles.push(AgentHandle {
                        agent_id: registration.node.id.clone(),
                        attempt_id: registration.attempt.id.clone(),
                        state: registration.node.state,
                        created: false,
                    });
                }
                self.spawn_batches.insert(
                    (parent_attempt_id.clone(), tool_call_id.clone()),
                    SpawnBatchRecord {
                        handles,
                        completion_policy: *completion_policy,
                    },
                );
            }
            AgentControlEventKind::StateChanged {
                agent_id,
                attempt_id,
                previous,
                next,
                state_revision,
            } => {
                let node = self
                    .nodes
                    .get_mut(agent_id)
                    .ok_or_else(|| AgentStoreError::AgentNotFound(agent_id.to_string()))?;
                let attempt = self
                    .attempts
                    .get_mut(attempt_id)
                    .ok_or_else(|| AgentStoreError::AttemptNotFound(attempt_id.to_string()))?;
                if attempt.agent_id != *agent_id {
                    return Err(AgentStoreError::AttemptAgentMismatch);
                }
                if node.state != *previous
                    || attempt.state != *previous
                    || !previous.can_transition_to(*next)
                    || node.state_revision.checked_add(1) != Some(*state_revision)
                    || attempt.state_revision.checked_add(1) != Some(*state_revision)
                {
                    return Err(AgentStoreError::InvalidEvent(
                        "state event does not continue the persisted revision".to_string(),
                    ));
                }
                node.state = *next;
                node.state_revision = *state_revision;
                node.updated_at.clone_from(&event.occurred_at);
                attempt.state = *next;
                attempt.state_revision = *state_revision;
                if *next == AgentState::Running && attempt.started_at.is_none() {
                    attempt.started_at = Some(event.occurred_at.clone());
                }
                if next.is_terminal() {
                    attempt.finished_at = Some(event.occurred_at.clone());
                }
            }
            AgentControlEventKind::ResultSubmitted {
                agent_id,
                attempt_id,
                result,
            } => {
                let attempt = self
                    .attempts
                    .get(attempt_id)
                    .ok_or_else(|| AgentStoreError::AttemptNotFound(attempt_id.to_string()))?;
                if attempt.agent_id != *agent_id {
                    return Err(AgentStoreError::AttemptAgentMismatch);
                }
                if let Some(existing) = self.results.get(attempt_id) {
                    if existing != result.as_ref() {
                        return Err(AgentStoreError::ResultConflict);
                    }
                } else {
                    self.results
                        .insert(attempt_id.clone(), result.as_ref().clone());
                }
            }
            AgentControlEventKind::AttemptCreated {
                registration,
                node_state_revision,
            } => {
                let attempt = &registration.attempt;
                let node = self
                    .nodes
                    .get_mut(&attempt.agent_id)
                    .ok_or_else(|| AgentStoreError::AgentNotFound(attempt.agent_id.to_string()))?;
                if node.state_revision.checked_add(1) != Some(*node_state_revision) {
                    return Err(AgentStoreError::InvalidEvent(
                        "follow-up attempt does not continue the node revision".to_string(),
                    ));
                }
                node.state = AgentState::Queued;
                node.state_revision = *node_state_revision;
                node.updated_at.clone_from(&event.occurred_at);
                node.task.clone_from(&registration.task);
                node.profile = registration.profile;
                node.policy.clone_from(&registration.policy);
                node.budget = registration.budget;
                node.workspace.clone_from(&registration.workspace);
                if self
                    .attempts
                    .insert(attempt.id.clone(), attempt.clone())
                    .is_some()
                {
                    return Err(AgentStoreError::InvalidEvent(
                        "attempt identifier was registered twice".to_string(),
                    ));
                }
                if let Some(idempotency_key) = &registration.idempotency_key {
                    self.followup_attempts.insert(
                        (attempt.agent_id.clone(), idempotency_key.clone()),
                        AgentHandle {
                            agent_id: attempt.agent_id.clone(),
                            attempt_id: attempt.id.clone(),
                            state: attempt.state,
                            created: false,
                        },
                    );
                }
            }
            AgentControlEventKind::MailboxCursorAdvanced { attempt_id, cursor } => {
                let attempt = self
                    .attempts
                    .get_mut(attempt_id)
                    .ok_or_else(|| AgentStoreError::AttemptNotFound(attempt_id.to_string()))?;
                if *cursor < attempt.mailbox_cursor {
                    return Err(AgentStoreError::InvalidEvent(
                        "mailbox cursor moved backwards".to_string(),
                    ));
                }
                attempt.mailbox_cursor = *cursor;
            }
            AgentControlEventKind::UsageRecorded {
                attempt_id, usage, ..
            } => {
                let attempt = self
                    .attempts
                    .get_mut(attempt_id)
                    .ok_or_else(|| AgentStoreError::AttemptNotFound(attempt_id.to_string()))?;
                if !usage_is_monotonic(&attempt.usage, usage) {
                    return Err(AgentStoreError::InvalidEvent(
                        "agent usage moved backwards".to_string(),
                    ));
                }
                attempt.usage = *usage;
            }
        }
        self.through_sequence = event.sequence;
        self.events.push(event);
        Ok(())
    }

    fn apply_registration(
        &mut self,
        registration: &AgentRegistration,
    ) -> Result<(), AgentStoreError> {
        if registration.node.root_run_id != self.root_run_id
            || registration.attempt.agent_id != registration.node.id
            || registration.attempt.state != registration.node.state
            || registration.attempt.state_revision != registration.node.state_revision
        {
            return Err(AgentStoreError::InvalidEvent(
                "agent registration identities or state do not agree".to_string(),
            ));
        }
        if self.nodes.contains_key(&registration.node.id)
            || self.attempts.contains_key(&registration.attempt.id)
        {
            return Err(AgentStoreError::InvalidEvent(
                "agent or attempt identifier was registered twice".to_string(),
            ));
        }
        self.nodes
            .insert(registration.node.id.clone(), registration.node.clone());
        self.attempts.insert(
            registration.attempt.id.clone(),
            registration.attempt.clone(),
        );
        Ok(())
    }
}

#[derive(Clone)]
pub struct AgentControlStore {
    runtime_root: PathBuf,
    persistence: Arc<dyn AtomicPersistence>,
    writer: Arc<Mutex<()>>,
}

impl AgentControlStore {
    #[must_use]
    pub fn new(runtime_root: impl AsRef<Path>, persistence: Arc<dyn AtomicPersistence>) -> Self {
        Self {
            runtime_root: runtime_root.as_ref().to_path_buf(),
            persistence,
            writer: Arc::new(Mutex::new(())),
        }
    }

    #[must_use]
    pub fn runtime_root(&self) -> &Path {
        &self.runtime_root
    }

    #[must_use]
    pub fn root_directory(&self, root_run_id: &RootRunId) -> PathBuf {
        self.runtime_root.join(root_storage_key(root_run_id))
    }

    #[must_use]
    pub fn ledger_path(&self, root_run_id: &RootRunId) -> PathBuf {
        self.root_directory(root_run_id).join(CONTROL_LEDGER_FILE)
    }

    pub async fn load(
        &self,
        root_run_id: &RootRunId,
    ) -> Result<AgentRootSnapshot, AgentStoreError> {
        let _writer = self.writer.lock().await;
        self.load_unlocked(root_run_id).await
    }

    pub async fn discover_root_run_ids(&self) -> Result<Vec<RootRunId>, AgentStoreError> {
        let mut roots = Vec::new();
        let mut entries = match tokio::fs::read_dir(&self.runtime_root).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(roots),
            Err(error) => {
                return Err(AppError::storage(
                    "Agent runtime directory could not be scanned",
                    format!("read {}: {error}", self.runtime_root.display()),
                    false,
                )
                .into());
            }
        };
        while let Some(entry) = entries.next_entry().await.map_err(|error| {
            AppError::storage(
                "Agent runtime directory could not be scanned",
                format!("read {}: {error}", self.runtime_root.display()),
                false,
            )
        })? {
            if roots.len() >= MAX_DISCOVERED_ROOTS {
                return Err(AgentStoreError::InvalidEvent(
                    "Agent runtime root discovery exceeded its bounded limit".to_string(),
                ));
            }
            if !entry
                .file_type()
                .await
                .map_err(|error| {
                    AppError::storage(
                        "Agent runtime entry could not be inspected",
                        format!("inspect {}: {error}", entry.path().display()),
                        false,
                    )
                })?
                .is_dir()
            {
                continue;
            }
            let ledger_path = entry.path().join(CONTROL_LEDGER_FILE);
            let Some(bytes) = self.persistence.read(&ledger_path).await? else {
                continue;
            };
            let text = std::str::from_utf8(&bytes).map_err(|error| {
                AgentStoreError::InvalidEvent(format!(
                    "Agent control ledger is not valid UTF-8: {error}"
                ))
            })?;
            let Some(first) = text.lines().find(|line| !line.trim().is_empty()) else {
                continue;
            };
            let event: AgentControlEvent = serde_json::from_str(first)
                .map_err(|source| AgentStoreError::InvalidJson { line: 1, source })?;
            roots.push(event.root_run_id);
        }
        roots.sort();
        roots.dedup();
        Ok(roots)
    }

    pub async fn register_root(
        &self,
        registration: AgentRegistration,
        event_id: String,
        occurred_at: String,
    ) -> Result<AgentHandle, AgentStoreError> {
        let _writer = self.writer.lock().await;
        let mut snapshot = self.load_unlocked(&registration.node.root_run_id).await?;
        if let Some(root) = snapshot.root_agent() {
            let attempt = snapshot
                .attempts
                .values()
                .find(|attempt| attempt.agent_id == root.id)
                .ok_or_else(|| {
                    AgentStoreError::InvalidEvent(
                        "root agent has no registered attempt".to_string(),
                    )
                })?;
            return Ok(AgentHandle {
                agent_id: root.id.clone(),
                attempt_id: attempt.id.clone(),
                state: root.state,
                created: false,
            });
        }
        let event = next_event(
            &snapshot,
            event_id,
            occurred_at,
            AgentControlEventKind::RootRegistered {
                registration: Box::new(registration.clone()),
            },
        )?;
        self.append_event(&event).await?;
        snapshot.apply(event)?;
        Ok(AgentHandle {
            agent_id: registration.node.id,
            attempt_id: registration.attempt.id,
            state: registration.node.state,
            created: true,
        })
    }

    pub async fn register_agents(
        &self,
        root_run_id: &RootRunId,
        parent_attempt_id: &AgentAttemptId,
        tool_call_id: &str,
        registrations: Vec<AgentRegistration>,
        event_id: String,
        occurred_at: String,
    ) -> Result<Vec<AgentHandle>, AgentStoreError> {
        self.register_agents_with_policy(
            root_run_id,
            parent_attempt_id,
            tool_call_id,
            registrations,
            AgentCompletionPolicy::CollectAll,
            event_id,
            occurred_at,
        )
        .await
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "durable Agent registration keeps idempotency, policy, and event identity explicit"
    )]
    pub async fn register_agents_with_policy(
        &self,
        root_run_id: &RootRunId,
        parent_attempt_id: &AgentAttemptId,
        tool_call_id: &str,
        registrations: Vec<AgentRegistration>,
        completion_policy: AgentCompletionPolicy,
        event_id: String,
        occurred_at: String,
    ) -> Result<Vec<AgentHandle>, AgentStoreError> {
        let _writer = self.writer.lock().await;
        let mut snapshot = self.load_unlocked(root_run_id).await?;
        let spawn_key = (parent_attempt_id.clone(), tool_call_id.to_string());
        if let Some(existing) = snapshot.spawn_batches.get(&spawn_key) {
            return Ok(existing.handles.clone());
        }
        let event = next_event(
            &snapshot,
            event_id,
            occurred_at,
            AgentControlEventKind::AgentsRegistered {
                parent_attempt_id: parent_attempt_id.clone(),
                tool_call_id: tool_call_id.to_string(),
                registrations: registrations.clone(),
                completion_policy,
            },
        )?;
        self.append_event(&event).await?;
        snapshot.apply(event)?;
        Ok(registrations
            .into_iter()
            .map(|registration| AgentHandle {
                agent_id: registration.node.id,
                attempt_id: registration.attempt.id,
                state: registration.node.state,
                created: true,
            })
            .collect())
    }

    pub async fn transition(
        &self,
        request: AgentTransitionRequest,
    ) -> Result<AgentNode, AgentStoreError> {
        let _writer = self.writer.lock().await;
        let mut snapshot = self.load_unlocked(&request.root_run_id).await?;
        let node = snapshot
            .nodes
            .get(&request.agent_id)
            .ok_or_else(|| AgentStoreError::AgentNotFound(request.agent_id.to_string()))?;
        let attempt = snapshot
            .attempts
            .get(&request.attempt_id)
            .ok_or_else(|| AgentStoreError::AttemptNotFound(request.attempt_id.to_string()))?;
        if attempt.agent_id != request.agent_id {
            return Err(AgentStoreError::AttemptAgentMismatch);
        }
        let transitioned = AgentStateSnapshot {
            state: node.state,
            revision: node.state_revision,
        }
        .transition(request.expected_revision, request.next)?;
        let event = next_event(
            &snapshot,
            request.event_id,
            request.occurred_at,
            AgentControlEventKind::StateChanged {
                agent_id: request.agent_id.clone(),
                attempt_id: request.attempt_id,
                previous: node.state,
                next: request.next,
                state_revision: transitioned.revision,
            },
        )?;
        self.append_event(&event).await?;
        snapshot.apply(event)?;
        snapshot
            .nodes
            .remove(&request.agent_id)
            .ok_or_else(|| AgentStoreError::AgentNotFound(request.agent_id.to_string()))
    }

    pub async fn submit_result(
        &self,
        root_run_id: &RootRunId,
        agent_id: &AgentId,
        attempt_id: &AgentAttemptId,
        result: AgentResult,
        event_id: String,
        occurred_at: String,
    ) -> Result<AgentResult, AgentStoreError> {
        let _writer = self.writer.lock().await;
        let mut snapshot = self.load_unlocked(root_run_id).await?;
        if let Some(existing) = snapshot.results.get(attempt_id) {
            if existing == &result {
                return Ok(existing.clone());
            }
            return Err(AgentStoreError::ResultConflict);
        }
        let event = next_event(
            &snapshot,
            event_id,
            occurred_at,
            AgentControlEventKind::ResultSubmitted {
                agent_id: agent_id.clone(),
                attempt_id: attempt_id.clone(),
                result: Box::new(result.clone()),
            },
        )?;
        self.append_event(&event).await?;
        snapshot.apply(event)?;
        Ok(result)
    }

    pub async fn create_attempt(
        &self,
        root_run_id: &RootRunId,
        registration: AgentAttemptRegistration,
        event_id: String,
        occurred_at: String,
    ) -> Result<AgentHandle, AgentStoreError> {
        let _writer = self.writer.lock().await;
        let mut snapshot = self.load_unlocked(root_run_id).await?;
        if let Some(idempotency_key) = registration.idempotency_key.as_deref()
            && let Some(existing) =
                snapshot.followup_attempt(&registration.attempt.agent_id, idempotency_key)
        {
            return Ok(existing);
        }
        let attempt = &registration.attempt;
        let node = snapshot
            .nodes
            .get(&attempt.agent_id)
            .ok_or_else(|| AgentStoreError::AgentNotFound(attempt.agent_id.to_string()))?;
        if !node.state.is_terminal() {
            return Err(AgentStoreError::InvalidEvent(
                "a follow-up attempt requires a terminal previous attempt".to_string(),
            ));
        }
        let node_state_revision = node
            .state_revision
            .checked_add(1)
            .ok_or(AgentStoreError::SequenceOverflow)?;
        let event = next_event(
            &snapshot,
            event_id,
            occurred_at,
            AgentControlEventKind::AttemptCreated {
                registration: Box::new(registration.clone()),
                node_state_revision,
            },
        )?;
        self.append_event(&event).await?;
        snapshot.apply(event)?;
        Ok(AgentHandle {
            agent_id: registration.attempt.agent_id,
            attempt_id: registration.attempt.id,
            state: AgentState::Queued,
            created: true,
        })
    }

    pub async fn events_after(
        &self,
        root_run_id: &RootRunId,
        after_sequence: u64,
        limit: usize,
    ) -> Result<Vec<AgentControlEvent>, AgentStoreError> {
        let snapshot = self.load(root_run_id).await?;
        Ok(snapshot
            .events
            .into_iter()
            .filter(|event| event.sequence > after_sequence)
            .take(limit)
            .collect())
    }

    pub async fn advance_mailbox_cursor(
        &self,
        root_run_id: &RootRunId,
        attempt_id: &AgentAttemptId,
        cursor: u64,
        event_id: String,
        occurred_at: String,
    ) -> Result<u64, AgentStoreError> {
        let _writer = self.writer.lock().await;
        let mut snapshot = self.load_unlocked(root_run_id).await?;
        let attempt = snapshot
            .attempts
            .get(attempt_id)
            .ok_or_else(|| AgentStoreError::AttemptNotFound(attempt_id.to_string()))?;
        if cursor <= attempt.mailbox_cursor {
            return Ok(attempt.mailbox_cursor);
        }
        let event = next_event(
            &snapshot,
            event_id,
            occurred_at,
            AgentControlEventKind::MailboxCursorAdvanced {
                attempt_id: attempt_id.clone(),
                cursor,
            },
        )?;
        self.append_event(&event).await?;
        snapshot.apply(event)?;
        Ok(cursor)
    }

    pub async fn record_usage(
        &self,
        root_run_id: &RootRunId,
        attempt_id: &AgentAttemptId,
        usage: AgentUsage,
        remaining: AgentBudget,
        event_id: String,
        occurred_at: String,
    ) -> Result<AgentUsage, AgentStoreError> {
        let _writer = self.writer.lock().await;
        let mut snapshot = self.load_unlocked(root_run_id).await?;
        let attempt = snapshot
            .attempts
            .get(attempt_id)
            .ok_or_else(|| AgentStoreError::AttemptNotFound(attempt_id.to_string()))?;
        if attempt.usage == usage {
            return Ok(usage);
        }
        if !usage_is_monotonic(&attempt.usage, &usage) {
            return Err(AgentStoreError::InvalidEvent(
                "agent usage moved backwards".to_string(),
            ));
        }
        let event = next_event(
            &snapshot,
            event_id,
            occurred_at,
            AgentControlEventKind::UsageRecorded {
                attempt_id: attempt_id.clone(),
                usage,
                remaining: Some(remaining),
            },
        )?;
        self.append_event(&event).await?;
        snapshot.apply(event)?;
        Ok(usage)
    }

    pub async fn recover_interrupted(
        &self,
        root_run_id: &RootRunId,
        id_prefix: &str,
        occurred_at: &str,
    ) -> Result<Vec<AgentHandle>, AgentStoreError> {
        let snapshot = self.load(root_run_id).await?;
        let recoverable = snapshot
            .attempts
            .values()
            .filter(|attempt| {
                matches!(
                    attempt.state,
                    AgentState::Starting
                        | AgentState::Running
                        | AgentState::WaitingMessage
                        | AgentState::WaitingChildren
                        | AgentState::AwaitingApproval
                        | AgentState::NeedsReplan
                        | AgentState::NeedsResolution
                )
            })
            .cloned()
            .collect::<Vec<_>>();
        let mut recovered = Vec::with_capacity(recoverable.len());
        for (index, attempt) in recoverable.into_iter().enumerate() {
            let node = self
                .transition(AgentTransitionRequest {
                    root_run_id: root_run_id.clone(),
                    agent_id: attempt.agent_id.clone(),
                    attempt_id: attempt.id.clone(),
                    expected_revision: attempt.state_revision,
                    next: AgentState::Interrupted,
                    event_id: format!("{id_prefix}-{index}"),
                    occurred_at: occurred_at.to_string(),
                })
                .await?;
            recovered.push(AgentHandle {
                agent_id: node.id,
                attempt_id: attempt.id,
                state: AgentState::Interrupted,
                created: false,
            });
        }
        Ok(recovered)
    }

    async fn load_unlocked(
        &self,
        root_run_id: &RootRunId,
    ) -> Result<AgentRootSnapshot, AgentStoreError> {
        let Some(bytes) = self
            .persistence
            .read(&self.ledger_path(root_run_id))
            .await?
        else {
            return Ok(AgentRootSnapshot::empty(root_run_id.clone()));
        };
        let mut snapshot = AgentRootSnapshot::empty(root_run_id.clone());
        for (line_index, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
            if line.is_empty() {
                continue;
            }
            let event = serde_json::from_slice::<AgentControlEvent>(line).map_err(|source| {
                AgentStoreError::InvalidJson {
                    line: line_index + 1,
                    source,
                }
            })?;
            if event.schema_version != CONTROL_EVENT_SCHEMA_VERSION {
                return Err(AgentStoreError::UnsupportedSchema(event.schema_version));
            }
            snapshot.apply(event)?;
        }
        Ok(snapshot)
    }

    async fn append_event(&self, event: &AgentControlEvent) -> Result<(), AgentStoreError> {
        let mut bytes = serde_json::to_vec(event).map_err(AgentStoreError::Serialize)?;
        bytes.push(b'\n');
        self.persistence
            .append(&self.ledger_path(&event.root_run_id), &bytes)
            .await?;
        Ok(())
    }
}

fn next_event(
    snapshot: &AgentRootSnapshot,
    event_id: String,
    occurred_at: String,
    kind: AgentControlEventKind,
) -> Result<AgentControlEvent, AgentStoreError> {
    Ok(AgentControlEvent {
        schema_version: CONTROL_EVENT_SCHEMA_VERSION,
        event_id,
        root_run_id: snapshot.root_run_id.clone(),
        sequence: snapshot
            .through_sequence
            .checked_add(1)
            .ok_or(AgentStoreError::SequenceOverflow)?,
        occurred_at,
        kind,
    })
}

fn root_storage_key(root_run_id: &RootRunId) -> String {
    format!(
        "root-{}",
        hex::encode(Sha256::digest(root_run_id.as_str().as_bytes()))
    )
}

const fn usage_is_monotonic(previous: &AgentUsage, next: &AgentUsage) -> bool {
    next.input_tokens >= previous.input_tokens
        && next.output_tokens >= previous.output_tokens
        && next.provider_cost_micros >= previous.provider_cost_micros
        && next.tool_calls >= previous.tool_calls
        && next.model_visible_tool_result_bytes >= previous.model_visible_tool_result_bytes
        && next.command_wall_time_ms >= previous.command_wall_time_ms
        && next.wall_time_ms >= previous.wall_time_ms
        && next.files_read >= previous.files_read
        && next.files_written >= previous.files_written
        && next.child_agents >= previous.child_agents
}
