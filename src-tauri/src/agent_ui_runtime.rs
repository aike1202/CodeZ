use std::{
    collections::{HashMap, HashSet},
    io::ErrorKind,
    sync::Arc,
};

use chrono::Utc;
use codez_contracts::agent::{AgentEventPage, AgentUiEvent, AgentUiEventEnvelope};
use codez_core::{
    AgentAttemptId, AgentId, AppError, AtomicPersistence, RootRunId, redact_sensitive_text,
};
use codez_runtime::agent::{
    AgentControlEventKind, AgentControlStore, AgentExecutionContext, AgentExecutionEvent,
    AgentExecutionEventSink,
};
use serde_json::Error as JsonError;
use tauri::{AppHandle, Emitter};
use thiserror::Error;
use tokio::{
    io::{AsyncBufReadExt, AsyncSeekExt, BufReader},
    sync::{Mutex, mpsc},
};

use crate::agent_boundary::{
    budget_contract, message_contract, result_contract, state_contract, usage_contract,
};

pub(crate) const AGENT_UI_EVENT_NAME: &str = "agent:ui-event";
const UI_EVENT_LEDGER_FILE: &str = "ui-events.jsonl";
const MAX_EVENT_PAGE_SIZE: usize = 500;
const EVENT_CHANNEL_DRAIN_LIMIT: usize = 256;
const EVENT_INDEX_STRIDE: u64 = 128;

#[derive(Debug, Error)]
pub(crate) enum AgentUiRuntimeError {
    #[error("Agent UI event could not be serialized")]
    Serialize(#[source] JsonError),
    #[error("Agent UI event ledger contains invalid JSON at line {line}")]
    InvalidJson {
        line: usize,
        #[source]
        source: JsonError,
    },
    #[error("Agent UI event sequence overflowed")]
    SequenceOverflow,
    #[error("Agent UI event page limit must be between 1 and {MAX_EVENT_PAGE_SIZE}")]
    InvalidPageLimit,
    #[error(transparent)]
    Storage(#[from] AppError),
    #[error(transparent)]
    Control(#[from] codez_runtime::agent::AgentStoreError),
}

impl From<AgentUiRuntimeError> for AppError {
    fn from(value: AgentUiRuntimeError) -> Self {
        match value {
            AgentUiRuntimeError::InvalidPageLimit => AppError::validation(value.to_string()),
            AgentUiRuntimeError::Storage(source) => source,
            other => AppError::storage(
                "Agent execution history could not be loaded",
                other.to_string(),
                false,
            ),
        }
    }
}

#[derive(Clone, Default)]
struct RootEventIndex {
    next_sequence_by_attempt: HashMap<String, u64>,
    state_revisions: HashSet<(String, u64)>,
    result_attempts: HashSet<String>,
    usage_snapshots: HashSet<(String, String)>,
    offsets_by_attempt: HashMap<String, Vec<(u64, u64)>>,
}

#[derive(Default)]
struct EventStoreState {
    roots: HashMap<RootRunId, RootEventIndex>,
}

#[derive(Clone)]
pub(crate) struct AgentUiEventStore {
    control: Arc<AgentControlStore>,
    persistence: Arc<dyn AtomicPersistence>,
    state: Arc<Mutex<EventStoreState>>,
}

impl AgentUiEventStore {
    #[must_use]
    pub(crate) fn new(
        control: Arc<AgentControlStore>,
        persistence: Arc<dyn AtomicPersistence>,
    ) -> Self {
        Self {
            control,
            persistence,
            state: Arc::new(Mutex::new(EventStoreState::default())),
        }
    }

    pub(crate) async fn page(
        &self,
        root_run_id: &RootRunId,
        agent_id: &AgentId,
        attempt_id: &AgentAttemptId,
        after_cursor: u64,
        limit: usize,
    ) -> Result<AgentEventPage, AgentUiRuntimeError> {
        if limit == 0 || limit > MAX_EVENT_PAGE_SIZE {
            return Err(AgentUiRuntimeError::InvalidPageLimit);
        }
        self.persist_root_batch(root_run_id, Vec::new()).await?;
        let start_offset = {
            let state = self.state.lock().await;
            state
                .roots
                .get(root_run_id)
                .and_then(|index| index.offsets_by_attempt.get(attempt_id.as_str()))
                .and_then(|offsets| {
                    offsets
                        .iter()
                        .rev()
                        .find(|(sequence, _)| *sequence <= after_cursor.saturating_add(1))
                        .map(|(_, offset)| *offset)
                })
                .unwrap_or(0)
        };
        let mut selected = self
            .read_page(
                root_run_id,
                agent_id,
                attempt_id,
                after_cursor,
                limit.saturating_add(1),
                start_offset,
            )
            .await?;
        let has_more = selected.len() > limit;
        if has_more {
            selected.pop();
        }
        let next_cursor = selected.last().map_or(after_cursor, |event| event.sequence);
        Ok(AgentEventPage {
            events: selected,
            next_cursor,
            has_more,
        })
    }

    async fn persist_batch(
        &self,
        requests: Vec<ProjectorRequest>,
    ) -> Result<Vec<AgentUiEventEnvelope>, AgentUiRuntimeError> {
        let mut by_root: HashMap<RootRunId, Vec<ProjectorRequest>> = HashMap::new();
        for request in requests {
            by_root
                .entry(request.context.node.root_run_id.clone())
                .or_default()
                .push(request);
        }
        let mut persisted = Vec::new();
        for (root_run_id, requests) in by_root {
            persisted.extend(self.persist_root_batch(&root_run_id, requests).await?);
        }
        Ok(persisted)
    }

    async fn persist_root_batch(
        &self,
        root_run_id: &RootRunId,
        requests: Vec<ProjectorRequest>,
    ) -> Result<Vec<AgentUiEventEnvelope>, AgentUiRuntimeError> {
        let snapshot = self.control.load(root_run_id).await?;
        let mut state = self.state.lock().await;
        if !state.roots.contains_key(root_run_id) {
            let index = self.load_index(root_run_id).await?;
            state.roots.insert(root_run_id.clone(), index);
        }
        let index = state
            .roots
            .get_mut(root_run_id)
            .ok_or(AgentUiRuntimeError::SequenceOverflow)?;
        let mut working_index = index.clone();
        let mut pending = Vec::new();
        for event in &snapshot.events {
            match &event.kind {
                AgentControlEventKind::StateChanged {
                    agent_id,
                    attempt_id,
                    previous,
                    next,
                    state_revision,
                } => {
                    let key = (attempt_id.to_string(), *state_revision);
                    if working_index.state_revisions.contains(&key) {
                        continue;
                    }
                    pending.push(PendingUiEvent {
                        root_run_id: root_run_id.to_string(),
                        agent_id: agent_id.to_string(),
                        attempt_id: attempt_id.to_string(),
                        state_revision: *state_revision,
                        occurred_at: event.occurred_at.clone(),
                        event: AgentUiEvent::StateChanged {
                            previous: state_contract(*previous),
                            next: state_contract(*next),
                        },
                    });
                }
                AgentControlEventKind::ResultSubmitted {
                    agent_id,
                    attempt_id,
                    result,
                } => {
                    if working_index.result_attempts.contains(attempt_id.as_str()) {
                        continue;
                    }
                    working_index.result_attempts.insert(attempt_id.to_string());
                    let state_revision = snapshot
                        .nodes
                        .get(agent_id)
                        .map_or(0, |node| node.state_revision);
                    pending.push(PendingUiEvent {
                        root_run_id: root_run_id.to_string(),
                        agent_id: agent_id.to_string(),
                        attempt_id: attempt_id.to_string(),
                        state_revision,
                        occurred_at: event.occurred_at.clone(),
                        event: AgentUiEvent::ResultSubmitted(result_contract(result)),
                    });
                }
                AgentControlEventKind::UsageRecorded {
                    attempt_id,
                    usage,
                    remaining,
                } => {
                    let usage_fingerprint = usage_fingerprint(usage)?;
                    let usage_key = (attempt_id.to_string(), usage_fingerprint);
                    if working_index.usage_snapshots.contains(&usage_key) {
                        continue;
                    }
                    working_index.usage_snapshots.insert(usage_key);
                    let Some(attempt) = snapshot.attempts.get(attempt_id) else {
                        continue;
                    };
                    let Some(node) = snapshot.nodes.get(&attempt.agent_id) else {
                        continue;
                    };
                    pending.push(PendingUiEvent {
                        root_run_id: root_run_id.to_string(),
                        agent_id: attempt.agent_id.to_string(),
                        attempt_id: attempt_id.to_string(),
                        state_revision: node.state_revision,
                        occurred_at: event.occurred_at.clone(),
                        event: AgentUiEvent::BudgetUpdated {
                            usage: usage_contract(*usage),
                            remaining: budget_contract(
                                remaining.unwrap_or_else(|| node.budget.saturating_sub(usage)),
                            ),
                        },
                    });
                }
                AgentControlEventKind::RootRegistered { .. }
                | AgentControlEventKind::AgentsRegistered { .. }
                | AgentControlEventKind::AttemptCreated { .. }
                | AgentControlEventKind::MailboxCursorAdvanced { .. } => {}
            }
        }
        for request in requests {
            if matches!(
                &request.event,
                AgentExecutionEvent::ResultSubmitted(_) | AgentExecutionEvent::UsageUpdated { .. }
            ) {
                continue;
            }
            let state_revision = snapshot
                .nodes
                .get(&request.context.node.id)
                .map_or(request.context.node.state_revision, |node| {
                    node.state_revision
                });
            pending.extend(project_execution_event(request, state_revision));
        }
        if pending.is_empty() {
            return Ok(Vec::new());
        }

        let mut envelopes = Vec::with_capacity(pending.len());
        for event in pending {
            let next = working_index
                .next_sequence_by_attempt
                .entry(event.attempt_id.clone())
                .or_insert(1);
            let sequence = *next;
            *next = next
                .checked_add(1)
                .ok_or(AgentUiRuntimeError::SequenceOverflow)?;
            if matches!(&event.event, AgentUiEvent::StateChanged { .. }) {
                working_index
                    .state_revisions
                    .insert((event.attempt_id.clone(), event.state_revision));
            }
            envelopes.push(AgentUiEventEnvelope {
                root_run_id: event.root_run_id,
                agent_id: event.agent_id,
                attempt_id: event.attempt_id,
                sequence,
                state_revision: event.state_revision,
                occurred_at: event.occurred_at,
                event: event.event,
            });
        }
        let path = self.event_path(root_run_id);
        let mut offset = match tokio::fs::metadata(&path).await {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == ErrorKind::NotFound => 0,
            Err(error) => return Err(event_io_error("read Agent event ledger metadata", error)),
        };
        let mut bytes = Vec::new();
        for envelope in &envelopes {
            record_index_event(&mut working_index, envelope, offset);
            let before = bytes.len();
            serde_json::to_writer(&mut bytes, envelope).map_err(AgentUiRuntimeError::Serialize)?;
            bytes.push(b'\n');
            offset = offset.saturating_add(
                u64::try_from(bytes.len().saturating_sub(before)).unwrap_or(u64::MAX),
            );
        }
        self.persistence.append(&path, &bytes).await?;
        *index = working_index;
        Ok(envelopes)
    }

    async fn load_index(
        &self,
        root_run_id: &RootRunId,
    ) -> Result<RootEventIndex, AgentUiRuntimeError> {
        let path = self.event_path(root_run_id);
        let file = match tokio::fs::File::open(&path).await {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Ok(RootEventIndex::default());
            }
            Err(error) => return Err(event_io_error("open Agent event ledger", error)),
        };
        let mut reader = BufReader::new(file);
        let mut index = RootEventIndex::default();
        let mut line = String::new();
        let mut line_number = 0_usize;
        let mut offset = 0_u64;
        loop {
            line.clear();
            let read = reader
                .read_line(&mut line)
                .await
                .map_err(|error| event_io_error("read Agent event ledger", error))?;
            if read == 0 {
                break;
            }
            line_number = line_number.saturating_add(1);
            if !line.trim().is_empty() {
                let event = serde_json::from_str(&line).map_err(|source| {
                    AgentUiRuntimeError::InvalidJson {
                        line: line_number,
                        source,
                    }
                })?;
                record_index_event(&mut index, &event, offset);
            }
            offset = offset.saturating_add(u64::try_from(read).unwrap_or(u64::MAX));
        }
        Ok(index)
    }

    async fn read_page(
        &self,
        root_run_id: &RootRunId,
        agent_id: &AgentId,
        attempt_id: &AgentAttemptId,
        after_cursor: u64,
        limit: usize,
        start_offset: u64,
    ) -> Result<Vec<AgentUiEventEnvelope>, AgentUiRuntimeError> {
        let path = self.event_path(root_run_id);
        let mut file = match tokio::fs::File::open(&path).await {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(event_io_error("open Agent event ledger", error)),
        };
        file.seek(std::io::SeekFrom::Start(start_offset))
            .await
            .map_err(|error| event_io_error("seek Agent event ledger", error))?;
        let mut reader = BufReader::new(file);
        let mut selected = Vec::with_capacity(limit);
        let mut line = String::new();
        let mut line_number = 0_usize;
        while selected.len() < limit {
            line.clear();
            let read = reader
                .read_line(&mut line)
                .await
                .map_err(|error| event_io_error("read Agent event ledger", error))?;
            if read == 0 {
                break;
            }
            line_number = line_number.saturating_add(1);
            if line.trim().is_empty() {
                continue;
            }
            let event: AgentUiEventEnvelope =
                serde_json::from_str(&line).map_err(|source| AgentUiRuntimeError::InvalidJson {
                    line: line_number,
                    source,
                })?;
            if event.agent_id == agent_id.as_str()
                && event.attempt_id == attempt_id.as_str()
                && event.sequence > after_cursor
            {
                selected.push(event);
            }
        }
        Ok(selected)
    }

    fn event_path(&self, root_run_id: &RootRunId) -> std::path::PathBuf {
        self.control
            .root_directory(root_run_id)
            .join(UI_EVENT_LEDGER_FILE)
    }
}

#[derive(Clone)]
pub(crate) struct AgentUiProjector {
    sender: mpsc::UnboundedSender<ProjectorRequest>,
}

impl AgentUiProjector {
    #[must_use]
    pub(crate) fn start(app: AppHandle, store: Arc<AgentUiEventStore>) -> Arc<Self> {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        tauri::async_runtime::spawn(async move {
            while let Some(first) = receiver.recv().await {
                let mut batch = Vec::with_capacity(EVENT_CHANNEL_DRAIN_LIMIT);
                batch.push(first);
                while batch.len() < EVENT_CHANNEL_DRAIN_LIMIT {
                    match receiver.try_recv() {
                        Ok(request) => batch.push(request),
                        Err(_) => break,
                    }
                }
                loop {
                    match store.persist_batch(batch.clone()).await {
                        Ok(events) => {
                            for event in events {
                                if let Err(source) = app.emit(AGENT_UI_EVENT_NAME, event) {
                                    tracing::warn!(
                                        diagnostic = %source,
                                        "persisted Agent UI event could not be emitted"
                                    );
                                }
                            }
                            break;
                        }
                        Err(error) => {
                            tracing::error!(
                                diagnostic = %error,
                                "Agent UI event persistence failed; retrying"
                            );
                            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                        }
                    }
                }
            }
        });
        Arc::new(Self { sender })
    }
}

impl AgentExecutionEventSink for AgentUiProjector {
    fn publish(&self, context: &AgentExecutionContext, event: AgentExecutionEvent) {
        if self
            .sender
            .send(ProjectorRequest {
                context: context.clone(),
                event,
            })
            .is_err()
        {
            tracing::error!("Agent UI projector stopped before accepting an execution event");
        }
    }
}

#[derive(Debug, Clone)]
struct ProjectorRequest {
    context: AgentExecutionContext,
    event: AgentExecutionEvent,
}

struct PendingUiEvent {
    root_run_id: String,
    agent_id: String,
    attempt_id: String,
    state_revision: u64,
    occurred_at: String,
    event: AgentUiEvent,
}

fn project_execution_event(request: ProjectorRequest, state_revision: u64) -> Vec<PendingUiEvent> {
    let context = request.context;
    let root_run_id = context.node.root_run_id.to_string();
    let agent_id = context.node.id.to_string();
    let attempt_id = context.attempt.id.to_string();
    let occurred_at = Utc::now().to_rfc3339();
    let events = match request.event {
        AgentExecutionEvent::StateChanged => Vec::new(),
        AgentExecutionEvent::AssistantDelta(delta) => {
            vec![AgentUiEvent::AssistantDelta { delta }]
        }
        AgentExecutionEvent::ReasoningDelta(delta) => {
            vec![AgentUiEvent::ReasoningDelta { delta }]
        }
        AgentExecutionEvent::MailboxReceived(messages) => messages
            .iter()
            .map(|message| AgentUiEvent::AgentMessageReceived(message_contract(message)))
            .collect(),
        AgentExecutionEvent::MessageSent(message) => {
            vec![AgentUiEvent::AgentMessageSent(message_contract(&message))]
        }
        AgentExecutionEvent::ToolBatchStarted(calls) => calls
            .into_iter()
            .map(|call| AgentUiEvent::ToolStarted {
                tool_call_id: call.id,
                name: call.function.name,
                summary: bounded_summary(&redact_sensitive_text(&call.function.arguments)),
            })
            .collect(),
        AgentExecutionEvent::ToolBatchCompleted(results) => {
            results.into_iter().flat_map(project_tool_result).collect()
        }
        AgentExecutionEvent::PermissionRequested {
            request_id,
            summary,
        } => vec![AgentUiEvent::PermissionRequested {
            request_id,
            summary: redact_sensitive_text(&summary),
        }],
        AgentExecutionEvent::PermissionResolved {
            request_id,
            approved,
        } => vec![AgentUiEvent::PermissionResolved {
            request_id,
            approved,
        }],
        AgentExecutionEvent::ProviderRetryScheduled {
            attempt,
            max_attempts,
            delay_ms,
            reason,
        } => vec![AgentUiEvent::ProviderRetryScheduled {
            attempt,
            max_attempts,
            delay_ms,
            reason,
        }],
        AgentExecutionEvent::ContextCompactionStarted {
            trigger,
            history_version,
        } => vec![AgentUiEvent::ContextCompactionStarted {
            trigger,
            history_version,
        }],
        AgentExecutionEvent::ContextCompactionCompleted {
            trigger,
            tokens_before,
            tokens_after,
            history_version,
        } => vec![AgentUiEvent::ContextCompactionCompleted {
            trigger,
            tokens_before,
            tokens_after,
            history_version,
        }],
        AgentExecutionEvent::ContextCompactionFailed {
            trigger,
            code,
            message,
            retryable,
            history_version,
        } => vec![AgentUiEvent::ContextCompactionFailed {
            trigger,
            code,
            message: redact_sensitive_text(&message),
            retryable,
            history_version,
        }],
        AgentExecutionEvent::UsageUpdated { usage, remaining } => {
            vec![AgentUiEvent::BudgetUpdated {
                usage: usage_contract(usage),
                remaining: budget_contract(remaining),
            }]
        }
        AgentExecutionEvent::ResultSubmitted(result) => {
            vec![AgentUiEvent::ResultSubmitted(result_contract(&result))]
        }
        AgentExecutionEvent::ErrorRaised { code, message } => {
            vec![AgentUiEvent::ErrorRaised {
                code,
                message: redact_sensitive_text(&message),
            }]
        }
    };
    events
        .into_iter()
        .map(|event| PendingUiEvent {
            root_run_id: root_run_id.clone(),
            agent_id: agent_id.clone(),
            attempt_id: attempt_id.clone(),
            state_revision,
            occurred_at: occurred_at.clone(),
            event,
        })
        .collect()
}

fn project_tool_result(result: codez_runtime::agent::AgentToolResult) -> Vec<AgentUiEvent> {
    let mut events = Vec::with_capacity(result.file_changes.len().saturating_add(1));
    events.push(AgentUiEvent::ToolCompleted {
        tool_call_id: result.call_id,
        name: result.name,
        status: result.status,
        summary: bounded_summary(&redact_sensitive_text(&result.model_content)),
    });
    events.extend(
        result
            .file_changes
            .into_iter()
            .map(|change| AgentUiEvent::FileChanged {
                path: change.path,
                change_kind: change.change_kind,
                transaction_id: change.transaction_id,
            }),
    );
    events
}

fn record_index_event(index: &mut RootEventIndex, event: &AgentUiEventEnvelope, offset: u64) {
    let next = event.sequence.saturating_add(1);
    index
        .next_sequence_by_attempt
        .entry(event.attempt_id.clone())
        .and_modify(|current| *current = (*current).max(next))
        .or_insert(next);
    if matches!(&event.event, AgentUiEvent::StateChanged { .. }) {
        index
            .state_revisions
            .insert((event.attempt_id.clone(), event.state_revision));
    }
    match &event.event {
        AgentUiEvent::ResultSubmitted(_) => {
            index.result_attempts.insert(event.attempt_id.clone());
        }
        AgentUiEvent::BudgetUpdated { usage, .. } => {
            if let Ok(fingerprint) = serde_json::to_string(usage) {
                index
                    .usage_snapshots
                    .insert((event.attempt_id.clone(), fingerprint));
            }
        }
        _ => {}
    }
    if event.sequence == 1 || event.sequence.saturating_sub(1) % EVENT_INDEX_STRIDE == 0 {
        let offsets = index
            .offsets_by_attempt
            .entry(event.attempt_id.clone())
            .or_default();
        if offsets
            .last()
            .is_none_or(|(sequence, _)| *sequence != event.sequence)
        {
            offsets.push((event.sequence, offset));
        }
    }
}

fn usage_fingerprint(usage: &codez_core::agent::AgentUsage) -> Result<String, AgentUiRuntimeError> {
    serde_json::to_string(&usage_contract(*usage)).map_err(AgentUiRuntimeError::Serialize)
}

#[cfg(test)]
fn index_events(events: &[AgentUiEventEnvelope]) -> RootEventIndex {
    let mut index = RootEventIndex::default();
    for (offset, event) in events.iter().enumerate() {
        record_index_event(&mut index, event, u64::try_from(offset).unwrap_or(u64::MAX));
    }
    index
}

fn bounded_summary(value: &str) -> String {
    const MAX_CHARS: usize = 512;
    let trimmed = value.trim();
    if trimmed.chars().count() <= MAX_CHARS {
        return trimmed.to_string();
    }
    trimmed.chars().take(MAX_CHARS).collect()
}

fn event_io_error(action: &str, error: std::io::Error) -> AgentUiRuntimeError {
    AppError::storage(
        "Agent execution history I/O failed",
        format!("{action}: {error}"),
        false,
    )
    .into()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use codez_contracts::agent::{AgentState as ContractState, AgentUiEvent};
    use codez_core::{AgentAttemptId, AgentId, AtomicPersistence, RootRunId};
    use codez_runtime::agent::{AgentControlStore, AgentFileChange, AgentToolResult};
    use codez_storage::AtomicFileStore;

    use super::{AgentUiEventEnvelope, AgentUiEventStore, index_events, project_tool_result};

    #[test]
    fn event_index_should_continue_attempt_sequences_and_remember_state_revisions() {
        let existing = vec![AgentUiEventEnvelope {
            root_run_id: "root-1".to_string(),
            agent_id: "agent-1".to_string(),
            attempt_id: "attempt-1".to_string(),
            sequence: 7,
            state_revision: 3,
            occurred_at: "2026-07-19T00:00:00Z".to_string(),
            event: AgentUiEvent::StateChanged {
                previous: ContractState::Starting,
                next: ContractState::Running,
            },
        }];

        let index = index_events(&existing);

        assert_eq!(index.next_sequence_by_attempt.get("attempt-1"), Some(&8));
        assert!(
            index
                .state_revisions
                .contains(&("attempt-1".to_string(), 3))
        );
    }

    #[tokio::test]
    async fn event_page_should_resume_from_a_sparse_attempt_offset() {
        let temp = tempfile::tempdir().expect("temporary Agent event root must exist");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let control = Arc::new(AgentControlStore::new(
            temp.path(),
            Arc::clone(&persistence),
        ));
        let store = AgentUiEventStore::new(control, Arc::clone(&persistence));
        let root_run_id = RootRunId::parse("root-page").expect("root ID must parse");
        let agent_id = AgentId::parse("agent-page").expect("Agent ID must parse");
        let attempt_id = AgentAttemptId::parse("attempt-page").expect("attempt ID must parse");
        let mut bytes = Vec::new();
        for sequence in 1..=300 {
            let event = AgentUiEventEnvelope {
                root_run_id: root_run_id.to_string(),
                agent_id: agent_id.to_string(),
                attempt_id: attempt_id.to_string(),
                sequence,
                state_revision: 1,
                occurred_at: "2026-07-19T00:00:00Z".to_string(),
                event: AgentUiEvent::AssistantDelta {
                    delta: sequence.to_string(),
                },
            };
            serde_json::to_writer(&mut bytes, &event).expect("event must serialize");
            bytes.push(b'\n');
        }
        persistence
            .replace(&store.event_path(&root_run_id), &bytes)
            .await
            .expect("event ledger must persist");

        let page = store
            .page(&root_run_id, &agent_id, &attempt_id, 200, 2)
            .await
            .expect("event page must load");

        assert_eq!(
            page.events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            [201, 202]
        );
    }

    #[test]
    fn tool_projection_should_emit_a_file_change_with_transaction_provenance() {
        let events = project_tool_result(AgentToolResult {
            call_id: "call-edit".to_string(),
            name: "Edit".to_string(),
            model_content: "updated".to_string(),
            status: "success".to_string(),
            file_changes: vec![AgentFileChange {
                path: "src/lib.rs".to_string(),
                change_kind: "modify".to_string(),
                transaction_id: "tx-agent".to_string(),
            }],
            usage: Default::default(),
        });

        assert!(matches!(
            &events[1],
            AgentUiEvent::FileChanged {
                path,
                transaction_id,
                ..
            } if path == "src/lib.rs" && transaction_id == "tx-agent"
        ));
    }

    #[test]
    fn tool_projection_should_redact_credentials_before_persisting_ui_summaries() {
        let events = project_tool_result(AgentToolResult {
            call_id: "call-secret".to_string(),
            name: "Bash".to_string(),
            model_content: "Authorization: Bearer token-123".to_string(),
            status: "success".to_string(),
            file_changes: Vec::new(),
            usage: Default::default(),
        });

        assert!(matches!(
            &events[0],
            AgentUiEvent::ToolCompleted { summary, .. }
                if summary.contains("[REDACTED]") && !summary.contains("token-123")
        ));
    }
}
