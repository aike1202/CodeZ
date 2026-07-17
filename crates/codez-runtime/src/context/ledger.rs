use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex as StdMutex, OnceLock, Weak,
        atomic::{AtomicU64, Ordering},
    },
};

use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use thiserror::Error;
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

use codez_core::context::{
    CONTEXT_SCHEMA_VERSION, ContextScopeId, HistoryRevertedPayload, LedgerAppendRequest,
    LedgerEvent, LedgerEventType, SessionRuntimeSnapshot, UserMessagePayload,
};
use codez_core::{AppError, AtomicPersistence, IdentifierError, SessionId};

use crate::context::{
    skill_state::apply_message_to_session_skill_states,
    state_machine::{StateMachineError, apply_event},
};

const MALFORMED_SUFFIX_WARNING: &str = "MALFORMED_LEDGER_SUFFIX_ISOLATED";
const INVALID_SUFFIX_WARNING: &str = "INVALID_LEDGER_SUFFIX_ISOLATED";
const DUPLICATE_RECORD_WARNING: &str = "DUPLICATE_LEDGER_RECORD_REMOVED";

/// Typed failures produced while validating, replaying, or persisting a model ledger.
#[derive(Debug, Error)]
pub enum LedgerError {
    #[error("invalid session identifier: {0}")]
    InvalidSessionId(#[from] IdentifierError),
    #[error("ledger request session does not match the command session")]
    SessionMismatch,
    #[error("ledger event identifier cannot be empty or exceed 256 bytes")]
    InvalidEventId,
    #[error("ledger event timestamp cannot be empty")]
    InvalidTimestamp,
    #[error("ledger sequence overflowed for session {session_id}")]
    SequenceOverflow { session_id: String },
    #[error("ledger history version overflowed for scope {scope_id}")]
    HistoryVersionOverflow { scope_id: String },
    #[error(
        "ledger history version changed for scope {scope_id}: expected {expected}, found {actual}"
    )]
    HistoryVersionConflict {
        scope_id: String,
        expected: u32,
        actual: u32,
    },
    #[error("event identifier {event_id} was already used for different content")]
    DuplicateEventId { event_id: String },
    #[error("ledger event payload is invalid for event {event_id}")]
    InvalidEventPayload {
        event_id: String,
        #[source]
        source: StateMachineError,
    },
    #[error("snapshot is invalid at {path}: {reason}")]
    InvalidSnapshot {
        path: PathBuf,
        reason: SnapshotViolation,
    },
    #[error("ledger requires a missing prefix before sequence {first_sequence}: {path}")]
    MissingLedgerPrefix { path: PathBuf, first_sequence: u32 },
    #[error("ledger runtime directory is unsafe: {0}")]
    UnsafeDirectory(PathBuf),
    #[error("ledger filesystem operation failed while attempting to {operation}: {path}")]
    DirectoryIo {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("ledger storage worker failed for {path}")]
    TaskJoin {
        path: PathBuf,
        #[source]
        source: tokio::task::JoinError,
    },
    #[error("ledger data could not be serialized for {path}")]
    Serialize {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error(transparent)]
    Persistence(#[from] AppError),
}

impl From<LedgerError> for AppError {
    fn from(error: LedgerError) -> Self {
        match error {
            LedgerError::Persistence(source) => source,
            error @ (LedgerError::InvalidSessionId(_)
            | LedgerError::SessionMismatch
            | LedgerError::InvalidEventId
            | LedgerError::InvalidTimestamp
            | LedgerError::InvalidEventPayload { .. }) => AppError::validation(error.to_string()),
            error @ (LedgerError::DuplicateEventId { .. }
            | LedgerError::SequenceOverflow { .. }
            | LedgerError::HistoryVersionOverflow { .. }
            | LedgerError::HistoryVersionConflict { .. }) => AppError::conflict(error.to_string()),
            error @ (LedgerError::InvalidSnapshot { .. }
            | LedgerError::MissingLedgerPrefix { .. }
            | LedgerError::UnsafeDirectory(_)
            | LedgerError::DirectoryIo { .. }
            | LedgerError::TaskJoin { .. }
            | LedgerError::Serialize { .. }) => AppError::storage(
                "Context data could not be loaded safely",
                error.to_string(),
                false,
            ),
        }
    }
}

/// Snapshot invariant violated by a persisted document.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SnapshotViolation {
    #[error("unsupported schema version {0}")]
    SchemaVersion(u16),
    #[error("snapshot session does not match its directory")]
    SessionMismatch,
    #[error("snapshot creation timestamp is empty")]
    EmptyTimestamp,
    #[error("snapshot contains an invalid scope key: {0}")]
    InvalidScope(String),
    #[error("scope history version exceeds the snapshot sequence")]
    HistoryVersionAhead,
    #[error("message source sequence exceeds the snapshot sequence")]
    MessageSequenceAhead,
    #[error("resume-state watermark exceeds the snapshot sequence")]
    ResumeSequenceAhead,
    #[error("skill-state sequence exceeds the snapshot sequence")]
    SkillSequenceAhead,
    #[error("post-compaction context sequence exceeds the snapshot sequence")]
    ContextSequenceAhead,
    #[error("snapshot JSON does not match the runtime schema")]
    InvalidJson,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
enum ReplayViolation {
    #[error("unsupported schema version {0}")]
    SchemaVersion(u16),
    #[error("event session does not match its directory")]
    SessionMismatch,
    #[error("event identifier is invalid")]
    InvalidEventId,
    #[error("event timestamp is empty")]
    EmptyTimestamp,
    #[error("event sequence is zero")]
    ZeroSequence,
    #[error("event sequence is not strictly increasing")]
    NonMonotonicSequence,
    #[error("event sequence is not contiguous")]
    SequenceGap,
    #[error("event history version is not contiguous")]
    HistoryVersion,
    #[error("event identifier conflicts with an earlier record")]
    DuplicateEventId,
    #[error("event payload does not match its declared type")]
    InvalidPayload,
}

struct LedgerRecordsRead {
    records: Vec<LedgerEvent>,
    quarantine_path: Option<PathBuf>,
}

struct ParsedLedgerRecords {
    records: Vec<LedgerEvent>,
    valid_prefix_end: usize,
    malformed_suffix: bool,
}

/// Reconstructed runtime plus non-fatal recovery warnings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoadedSessionRuntime {
    pub snapshot: SessionRuntimeSnapshot,
    pub warnings: Vec<String>,
}

/// Immutable history state used to coordinate an edit rollback with a ledger append.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryRevertPlan {
    pub expected_history_version: u32,
    pub payload: HistoryRevertedPayload,
}

#[derive(Clone)]
struct CacheEntry {
    runtime: LoadedSessionRuntime,
    events_by_id: HashMap<String, LedgerEvent>,
    generation: u64,
}

struct SessionCoordination {
    writer: Mutex<()>,
    generation: AtomicU64,
}

impl SessionCoordination {
    fn new() -> Self {
        Self {
            writer: Mutex::new(()),
            generation: AtomicU64::new(0),
        }
    }
}

type CoordinationRegistry = StdMutex<HashMap<PathBuf, Weak<SessionCoordination>>>;

static SESSION_COORDINATION: OnceLock<CoordinationRegistry> = OnceLock::new();

/// Crash-recoverable, single-writer store for per-session context ledgers.
#[derive(Clone)]
pub struct ModelLedgerStore {
    pub runtime_root: PathBuf,
    persistence: Arc<dyn AtomicPersistence>,
    cache: Arc<RwLock<HashMap<SessionId, CacheEntry>>>,
    coordinations: Arc<StdMutex<HashMap<SessionId, Arc<SessionCoordination>>>>,
}

impl ModelLedgerStore {
    #[must_use]
    pub fn new(runtime_root: impl AsRef<Path>, persistence: Arc<dyn AtomicPersistence>) -> Self {
        Self {
            runtime_root: runtime_root.as_ref().to_path_buf(),
            persistence,
            cache: Arc::new(RwLock::new(HashMap::new())),
            coordinations: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    #[must_use]
    pub fn session_directory(&self, session_id: &SessionId) -> PathBuf {
        self.runtime_root.join(session_id.as_str())
    }

    #[must_use]
    pub fn ledger_path(&self, session_id: &SessionId) -> PathBuf {
        self.session_directory(session_id).join("ledger.jsonl")
    }

    #[must_use]
    pub fn snapshot_path(&self, session_id: &SessionId) -> PathBuf {
        self.session_directory(session_id).join("snapshot.json")
    }

    /// Removes one session's reconstructed context history and invalidates all in-memory copies.
    ///
    /// The per-session writer lock prevents a concurrent ledger append from interleaving with
    /// removal. Callers must first stop the producers that own the session; a later append is
    /// intentionally allowed to create a new ledger for a newly created session with the same ID.
    ///
    /// # Errors
    ///
    /// Returns [`LedgerError`] when the runtime directory is unsafe or cannot be removed.
    pub async fn delete_session(&self, session_id: &SessionId) -> Result<bool, LedgerError> {
        let coordination = self.coordination(session_id);
        let _writer = coordination.writer.lock().await;
        let runtime_root = self.runtime_root.clone();
        let session_directory = self.session_directory(session_id);
        let error_path = session_directory.clone();
        let removed = tokio::task::spawn_blocking(move || {
            remove_session_directory_blocking(&runtime_root, &session_directory)
        })
        .await
        .map_err(|source| LedgerError::TaskJoin {
            path: error_path,
            source,
        })??;

        if removed {
            coordination.generation.fetch_add(1, Ordering::AcqRel);
        }
        self.cache.write().await.remove(session_id);
        self.coordinations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id);
        Ok(removed)
    }

    /// Assigns sequence and history versions, then durably appends one event.
    ///
    /// Reusing an event id with identical client-authored content is idempotent
    /// and returns the existing event. Reusing it with different content fails.
    ///
    /// # Errors
    ///
    /// Returns [`LedgerError`] for invalid identifiers or payloads, unsafe paths,
    /// conflicting event ids, storage failures, and unrecoverable persisted state.
    pub async fn append_event(
        &self,
        request: LedgerAppendRequest,
    ) -> Result<LedgerEvent, LedgerError> {
        let session_id = SessionId::parse(request.session_id.clone())?;
        self.append_event_for(&session_id, request).await
    }

    /// Appends a request after verifying it belongs to the supplied session.
    ///
    /// # Errors
    ///
    /// Returns [`LedgerError`] under the same conditions as [`Self::append_event`],
    /// plus [`LedgerError::SessionMismatch`] when the identities differ.
    pub async fn append_event_for(
        &self,
        session_id: &SessionId,
        request: LedgerAppendRequest,
    ) -> Result<LedgerEvent, LedgerError> {
        self.append_event_for_expected_history_version(session_id, None, request)
            .await
    }

    /// Appends a request only when the target scope still has the expected history version.
    ///
    /// The version check and append share the session writer lock, so callers can safely
    /// discard work derived from an older history rather than overwrite newer state.
    ///
    /// # Errors
    ///
    /// Returns [`LedgerError::HistoryVersionConflict`] when the scope changed before the
    /// append could be committed, plus the errors documented by [`Self::append_event_for`].
    pub async fn append_event_if_history_version(
        &self,
        session_id: &SessionId,
        expected_history_version: u32,
        request: LedgerAppendRequest,
    ) -> Result<LedgerEvent, LedgerError> {
        self.append_event_for_expected_history_version(
            session_id,
            Some(expected_history_version),
            request,
        )
        .await
    }

    async fn append_event_for_expected_history_version(
        &self,
        session_id: &SessionId,
        expected_history_version: Option<u32>,
        request: LedgerAppendRequest,
    ) -> Result<LedgerEvent, LedgerError> {
        if request.session_id != session_id.as_str() {
            return Err(LedgerError::SessionMismatch);
        }
        validate_request(&request)?;

        let coordination = self.coordination(session_id);
        let _writer = coordination.writer.lock().await;
        self.prepare_session_directory(session_id, true).await?;
        let mut cache_entry = self
            .load_locked(session_id, &coordination)
            .await?
            .unwrap_or_else(|| CacheEntry {
                runtime: empty_runtime(session_id),
                events_by_id: HashMap::new(),
                generation: coordination.generation.load(Ordering::Acquire),
            });

        if let Some(existing) = cache_entry.events_by_id.get(&request.event_id) {
            if request_matches_event(&request, existing) {
                return Ok(existing.clone());
            }
            return Err(LedgerError::DuplicateEventId {
                event_id: request.event_id,
            });
        }

        let scope_id = request.context_scope_id.as_key();
        let current_history_version = cache_entry
            .runtime
            .snapshot
            .scopes
            .get(scope_id.as_ref())
            .map_or(0, |scope| scope.history_version);
        if let Some(expected) = expected_history_version {
            if current_history_version != expected {
                return Err(LedgerError::HistoryVersionConflict {
                    scope_id: scope_id.into_owned(),
                    expected,
                    actual: current_history_version,
                });
            }
        }

        let sequence = cache_entry
            .runtime
            .snapshot
            .through_sequence
            .checked_add(1)
            .ok_or_else(|| LedgerError::SequenceOverflow {
                session_id: session_id.as_str().to_string(),
            })?;
        let history_version = if request.r#type.changes_history() {
            current_history_version.checked_add(1).ok_or_else(|| {
                LedgerError::HistoryVersionOverflow {
                    scope_id: scope_id.into_owned(),
                }
            })?
        } else {
            current_history_version
        };
        let event = LedgerEvent {
            schema_version: CONTEXT_SCHEMA_VERSION,
            event_id: request.event_id,
            session_id: request.session_id,
            context_scope_id: request.context_scope_id,
            sequence,
            history_version,
            turn_id: request.turn_id,
            created_at: request.created_at,
            r#type: request.r#type,
            payload: request.payload,
        };
        let mut candidate = cache_entry.runtime.clone();
        apply_event(&mut candidate, &event).map_err(|source| LedgerError::InvalidEventPayload {
            event_id: event.event_id.clone(),
            source,
        })?;

        let ledger_path = self.ledger_path(session_id);
        let bytes = serialize_json_line(&ledger_path, &event)?;
        if let Err(source) = self.persistence.append(&ledger_path, &bytes).await {
            coordination.generation.fetch_add(1, Ordering::AcqRel);
            self.cache.write().await.remove(session_id);
            return Err(LedgerError::Persistence(source));
        }
        let generation = coordination.generation.fetch_add(1, Ordering::AcqRel) + 1;
        cache_entry
            .events_by_id
            .insert(event.event_id.clone(), event.clone());
        cache_entry.runtime = candidate;
        cache_entry.generation = generation;
        self.cache
            .write()
            .await
            .insert(session_id.clone(), cache_entry);
        Ok(event)
    }

    /// Replays a snapshot and its JSONL tail into the current runtime state.
    ///
    /// # Errors
    ///
    /// Returns [`LedgerError`] when the session id, directory, snapshot, or
    /// storage cannot be validated or recovered safely.
    pub async fn load(
        &self,
        session_id: &SessionId,
    ) -> Result<Option<LoadedSessionRuntime>, LedgerError> {
        let coordination = self.coordination(session_id);
        let _writer = coordination.writer.lock().await;
        self.load_locked(session_id, &coordination)
            .await
            .map(|entry| entry.map(|entry| entry.runtime))
    }

    /// Returns the reconstructed snapshot after replaying all durable tail events.
    ///
    /// # Errors
    ///
    /// Returns [`LedgerError`] under the same conditions as [`Self::load`].
    pub async fn get_snapshot(
        &self,
        session_id: &SessionId,
    ) -> Result<Option<SessionRuntimeSnapshot>, LedgerError> {
        self.load(session_id)
            .await
            .map(|runtime| runtime.map(|runtime| runtime.snapshot))
    }

    /// Plans a history revert without mutating the durable ledger.
    ///
    /// The returned history version must be supplied to
    /// [`Self::append_event_if_history_version`] after external edit transactions have been
    /// reverted. This prevents stale UI state from replacing newer model history.
    ///
    /// # Errors
    ///
    /// Returns an error when the target is empty, the scope or message is missing, the target is
    /// represented by a compaction summary, or persisted ledger state cannot be loaded safely.
    pub async fn plan_history_revert(
        &self,
        session_id: &SessionId,
        context_scope_id: &ContextScopeId,
        target_ui_message_id: &str,
    ) -> Result<HistoryRevertPlan, AppError> {
        if target_ui_message_id.trim().is_empty() {
            return Err(AppError::validation("History revert target is empty"));
        }

        let coordination = self.coordination(session_id);
        let _writer = coordination.writer.lock().await;
        let entry = self
            .load_locked(session_id, &coordination)
            .await?
            .ok_or_else(|| AppError::not_found("The session has no context history"))?;
        let scope_key = context_scope_id.as_key();
        let scope = entry
            .runtime
            .snapshot
            .scopes
            .get(scope_key.as_ref())
            .ok_or_else(|| AppError::not_found("The requested context scope was not found"))?;

        let target_message_id = scope
            .active_messages
            .iter()
            .find(|message| {
                message.role == "user"
                    && message.client_message_id.as_deref() == Some(target_ui_message_id)
            })
            .map(|message| message.id.clone())
            .or_else(|| {
                entry
                    .events_by_id
                    .values()
                    .filter(|event| {
                        event.context_scope_id == *context_scope_id
                            && event.r#type == LedgerEventType::UserMessage
                    })
                    .filter_map(|event| {
                        let payload =
                            serde_json::from_value::<UserMessagePayload>(event.payload.clone())
                                .ok()?;
                        let ui_message_id = payload
                            .command_metadata
                            .as_ref()?
                            .get("uiMessageId")?
                            .as_str()?;
                        (ui_message_id == target_ui_message_id)
                            .then_some((event.sequence, payload.message.id))
                    })
                    .max_by_key(|(sequence, _)| *sequence)
                    .map(|(_, message_id)| message_id)
            });
        let target_index = target_message_id
            .as_deref()
            .and_then(|message_id| {
                scope
                    .active_messages
                    .iter()
                    .position(|message| message.id == message_id)
            })
            .ok_or_else(|| {
                AppError::conflict(
                    "The requested history point is no longer present after compaction",
                )
            })?;
        let target_message = &scope.active_messages[target_index];
        if target_message.role != "user" || history_target_is_compacted(scope, target_message) {
            return Err(AppError::conflict(
                "The requested history point is represented inside a compacted summary",
            ));
        }

        let active_messages = scope.active_messages[..target_index].to_vec();
        let mut skill_states = scope
            .post_compaction_skill_states
            .clone()
            .unwrap_or_default();
        for message in &active_messages {
            skill_states = apply_message_to_session_skill_states(
                Some(&skill_states),
                &active_messages,
                message,
            );
        }

        Ok(HistoryRevertPlan {
            expected_history_version: scope.history_version,
            payload: HistoryRevertedPayload {
                source_history_version: scope.history_version,
                target_ui_message_id: target_ui_message_id.to_string(),
                target_message_id: target_message.id.clone(),
                active_messages,
                skill_states: Some(skill_states),
            },
        })
    }

    /// Persists the fully replayed runtime as the next atomic snapshot.
    ///
    /// The JSONL ledger is retained; physical compaction can therefore never
    /// make a snapshot write the only copy of context history.
    ///
    /// # Errors
    ///
    /// Returns [`LedgerError`] when loading, validation, or atomic persistence fails.
    pub async fn write_snapshot(
        &self,
        session_id: &SessionId,
    ) -> Result<Option<SessionRuntimeSnapshot>, LedgerError> {
        let coordination = self.coordination(session_id);
        let _writer = coordination.writer.lock().await;
        let Some(mut entry) = self.load_locked(session_id, &coordination).await? else {
            return Ok(None);
        };
        entry.runtime.snapshot.created_at = now_timestamp();
        validate_snapshot(
            session_id,
            &entry.runtime.snapshot,
            &self.snapshot_path(session_id),
        )?;
        let snapshot_path = self.snapshot_path(session_id);
        let bytes = serialize_json_pretty(&snapshot_path, &entry.runtime.snapshot)?;
        self.persistence.replace(&snapshot_path, &bytes).await?;
        let generation = coordination.generation.fetch_add(1, Ordering::AcqRel) + 1;
        entry.generation = generation;
        let snapshot = entry.runtime.snapshot.clone();
        self.cache.write().await.insert(session_id.clone(), entry);
        Ok(Some(snapshot))
    }

    fn coordination(&self, session_id: &SessionId) -> Arc<SessionCoordination> {
        if let Some(coordination) = self
            .coordinations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session_id)
            .cloned()
        {
            return coordination;
        }
        let key = self.session_directory(session_id);
        let registry = SESSION_COORDINATION.get_or_init(|| StdMutex::new(HashMap::new()));
        let mut coordinators = registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        coordinators.retain(|_, weak| weak.strong_count() > 0);
        let coordination = match coordinators.get(&key).and_then(Weak::upgrade) {
            Some(coordination) => coordination,
            None => {
                let coordination = Arc::new(SessionCoordination::new());
                coordinators.insert(key, Arc::downgrade(&coordination));
                coordination
            }
        };
        drop(coordinators);
        self.coordinations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(session_id.clone(), Arc::clone(&coordination));
        coordination
    }

    async fn load_locked(
        &self,
        session_id: &SessionId,
        coordination: &SessionCoordination,
    ) -> Result<Option<CacheEntry>, LedgerError> {
        let generation = coordination.generation.load(Ordering::Acquire);
        if let Some(cached) = self.cache.read().await.get(session_id) {
            if cached.generation == generation {
                return Ok(Some(cached.clone()));
            }
        }
        let Some((mut entry, changed_storage)) = self.load_from_disk(session_id).await? else {
            self.cache.write().await.remove(session_id);
            return Ok(None);
        };
        let generation = if changed_storage {
            coordination.generation.fetch_add(1, Ordering::AcqRel) + 1
        } else {
            coordination.generation.load(Ordering::Acquire)
        };
        entry.generation = generation;
        self.cache
            .write()
            .await
            .insert(session_id.clone(), entry.clone());
        Ok(Some(entry))
    }

    async fn load_from_disk(
        &self,
        session_id: &SessionId,
    ) -> Result<Option<(CacheEntry, bool)>, LedgerError> {
        if !self.prepare_session_directory(session_id, false).await? {
            return Ok(None);
        }
        let snapshot_path = self.snapshot_path(session_id);
        let snapshot = self.read_snapshot(session_id, &snapshot_path).await?;
        let ledger_path = self.ledger_path(session_id);
        let ledger = self.read_ledger_records(&ledger_path).await?;
        if snapshot.is_none() && ledger.is_none() {
            return Ok(None);
        }

        let mut runtime = snapshot
            .map(|snapshot| LoadedSessionRuntime {
                snapshot,
                warnings: Vec::new(),
            })
            .unwrap_or_else(|| empty_runtime(session_id));
        let snapshot_through_sequence = runtime.snapshot.through_sequence;
        let mut changed_storage = false;
        let mut events_by_id = HashMap::new();
        let mut accepted_records = Vec::new();
        let mut previous_file_sequence = None;

        if let Some(ledger) = ledger {
            if ledger.quarantine_path.is_some() {
                runtime.warnings.push(MALFORMED_SUFFIX_WARNING.to_string());
                changed_storage = true;
            }
            if snapshot_through_sequence == 0 {
                if let Some(first_sequence) = ledger.records.first().map(|event| event.sequence) {
                    if first_sequence > 1 {
                        return Err(LedgerError::MissingLedgerPrefix {
                            path: ledger_path,
                            first_sequence,
                        });
                    }
                }
            }

            let mut invalid_suffix = None;
            let mut removed_duplicate = false;
            for (index, event) in ledger.records.iter().enumerate() {
                if let Some(existing) = events_by_id.get(&event.event_id) {
                    if existing == event {
                        removed_duplicate = true;
                        continue;
                    }
                    invalid_suffix = Some((index, ReplayViolation::DuplicateEventId));
                    break;
                }
                if let Err(violation) = validate_replay_identity(session_id, event) {
                    invalid_suffix = Some((index, violation));
                    break;
                }
                if previous_file_sequence.is_some_and(|previous| event.sequence <= previous) {
                    invalid_suffix = Some((index, ReplayViolation::NonMonotonicSequence));
                    break;
                }
                previous_file_sequence = Some(event.sequence);

                if event.sequence > snapshot_through_sequence {
                    let expected_sequence = runtime
                        .snapshot
                        .through_sequence
                        .checked_add(1)
                        .ok_or_else(|| LedgerError::SequenceOverflow {
                            session_id: session_id.as_str().to_string(),
                        })?;
                    if event.sequence != expected_sequence {
                        invalid_suffix = Some((index, ReplayViolation::SequenceGap));
                        break;
                    }
                    let scope_id = event.context_scope_id.as_key();
                    let current_history_version = runtime
                        .snapshot
                        .scopes
                        .get(scope_id.as_ref())
                        .map_or(0, |scope| scope.history_version);
                    let expected_history_version = if event.r#type.changes_history() {
                        current_history_version.checked_add(1).ok_or_else(|| {
                            LedgerError::HistoryVersionOverflow {
                                scope_id: scope_id.into_owned(),
                            }
                        })?
                    } else {
                        current_history_version
                    };
                    if event.history_version != expected_history_version {
                        invalid_suffix = Some((index, ReplayViolation::HistoryVersion));
                        break;
                    }
                    let mut candidate = runtime.clone();
                    if apply_event(&mut candidate, event).is_err() {
                        invalid_suffix = Some((index, ReplayViolation::InvalidPayload));
                        break;
                    }
                    runtime = candidate;
                }

                accepted_records.push(event.clone());
                events_by_id.insert(event.event_id.clone(), event.clone());
            }

            if let Some((index, violation)) = invalid_suffix {
                self.isolate_invalid_suffix(
                    &ledger_path,
                    &accepted_records,
                    &ledger.records[index..],
                    &violation,
                )
                .await?;
                runtime.warnings.push(INVALID_SUFFIX_WARNING.to_string());
                changed_storage = true;
            } else if removed_duplicate {
                let bytes = serialize_json_lines(&ledger_path, &accepted_records)?;
                self.persistence.replace(&ledger_path, &bytes).await?;
                runtime.warnings.push(DUPLICATE_RECORD_WARNING.to_string());
                changed_storage = true;
            }
        }

        derive_missing_skill_states(&mut runtime);
        Ok(Some((
            CacheEntry {
                runtime,
                events_by_id,
                generation: 0,
            },
            changed_storage,
        )))
    }

    async fn read_snapshot(
        &self,
        session_id: &SessionId,
        path: &Path,
    ) -> Result<Option<SessionRuntimeSnapshot>, LedgerError> {
        let Some(bytes) = self.persistence.read(path).await? else {
            return Ok(None);
        };
        let snapshot =
            serde_json::from_slice(&bytes).map_err(|_| LedgerError::InvalidSnapshot {
                path: path.to_path_buf(),
                reason: SnapshotViolation::InvalidJson,
            })?;
        validate_snapshot(session_id, &snapshot, path)?;
        Ok(Some(snapshot))
    }

    async fn read_ledger_records(
        &self,
        ledger_path: &Path,
    ) -> Result<Option<LedgerRecordsRead>, LedgerError> {
        let Some(bytes) = self.persistence.read(ledger_path).await? else {
            return Ok(None);
        };
        let parsed = parse_ledger_records(&bytes);
        let quarantine_path = if parsed.malformed_suffix {
            let parent = ledger_path
                .parent()
                .ok_or_else(|| LedgerError::UnsafeDirectory(ledger_path.to_path_buf()))?;
            let quarantine_path =
                parent.join(format!("ledger.jsonl.corrupt-{}.jsonl", Uuid::new_v4()));
            self.persistence
                .create_no_clobber(&quarantine_path, &bytes)
                .await?;
            self.persistence
                .replace(ledger_path, &bytes[..parsed.valid_prefix_end])
                .await?;
            Some(quarantine_path)
        } else {
            None
        };
        Ok(Some(LedgerRecordsRead {
            records: parsed.records,
            quarantine_path,
        }))
    }

    async fn isolate_invalid_suffix(
        &self,
        ledger_path: &Path,
        valid_prefix: &[LedgerEvent],
        invalid_suffix: &[LedgerEvent],
        violation: &ReplayViolation,
    ) -> Result<(), LedgerError> {
        let parent = ledger_path
            .parent()
            .ok_or_else(|| LedgerError::UnsafeDirectory(ledger_path.to_path_buf()))?;
        let quarantine_path = parent.join(format!(
            "ledger.jsonl.invalid-{}-{}.jsonl",
            violation_code(violation),
            Uuid::new_v4()
        ));
        let invalid_bytes = serialize_json_lines(&quarantine_path, invalid_suffix)?;
        self.persistence
            .create_no_clobber(&quarantine_path, &invalid_bytes)
            .await?;
        let valid_bytes = serialize_json_lines(ledger_path, valid_prefix)?;
        self.persistence.replace(ledger_path, &valid_bytes).await?;
        Ok(())
    }

    async fn prepare_session_directory(
        &self,
        session_id: &SessionId,
        create: bool,
    ) -> Result<bool, LedgerError> {
        let root = self.runtime_root.clone();
        let session_directory = self.session_directory(session_id);
        let error_path = session_directory.clone();
        tokio::task::spawn_blocking(move || {
            prepare_session_directory_blocking(&root, &session_directory, create)
        })
        .await
        .map_err(|source| LedgerError::TaskJoin {
            path: error_path,
            source,
        })?
    }
}

fn history_target_is_compacted(
    scope: &codez_core::context::SessionRuntimeScopeSnapshot,
    target: &codez_core::context::NormalizedModelMessage,
) -> bool {
    if target.id.starts_with("legacy:") {
        return true;
    }
    let covered_through_sequence = scope
        .latest_compaction
        .as_ref()
        .and_then(|summary| summary.get("coveredThroughSequence"))
        .and_then(serde_json::Value::as_u64);
    target.source_sequence.is_some_and(|sequence| {
        covered_through_sequence.is_some_and(|covered| u64::from(sequence) <= covered)
    })
}

fn parse_ledger_records(bytes: &[u8]) -> ParsedLedgerRecords {
    let mut records = Vec::new();
    let mut cursor = 0;
    let mut valid_prefix_end = 0;

    while cursor < bytes.len() {
        let line_end = bytes[cursor..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |relative| cursor + relative + 1);
        let mut record_bytes = &bytes[cursor..line_end];
        if record_bytes.last() == Some(&b'\n') {
            record_bytes = &record_bytes[..record_bytes.len() - 1];
        }
        if record_bytes.iter().all(u8::is_ascii_whitespace) {
            valid_prefix_end = line_end;
            cursor = line_end;
            continue;
        }
        let Ok(record) = serde_json::from_slice(record_bytes) else {
            return ParsedLedgerRecords {
                records,
                valid_prefix_end,
                malformed_suffix: true,
            };
        };
        records.push(record);
        valid_prefix_end = line_end;
        cursor = line_end;
    }

    ParsedLedgerRecords {
        records,
        valid_prefix_end,
        malformed_suffix: false,
    }
}

fn serialize_json_line<T>(path: &Path, value: &T) -> Result<Vec<u8>, LedgerError>
where
    T: Serialize + ?Sized,
{
    let mut bytes = serde_json::to_vec(value).map_err(|source| LedgerError::Serialize {
        path: path.to_path_buf(),
        source,
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn serialize_json_lines(path: &Path, records: &[LedgerEvent]) -> Result<Vec<u8>, LedgerError> {
    let mut bytes = Vec::new();
    for record in records {
        serde_json::to_writer(&mut bytes, record).map_err(|source| LedgerError::Serialize {
            path: path.to_path_buf(),
            source,
        })?;
        bytes.push(b'\n');
    }
    Ok(bytes)
}

fn serialize_json_pretty<T>(path: &Path, value: &T) -> Result<Vec<u8>, LedgerError>
where
    T: Serialize + ?Sized,
{
    serde_json::to_vec_pretty(value).map_err(|source| LedgerError::Serialize {
        path: path.to_path_buf(),
        source,
    })
}

fn validate_request(request: &LedgerAppendRequest) -> Result<(), LedgerError> {
    if request.event_id.trim().is_empty() || request.event_id.len() > 256 {
        return Err(LedgerError::InvalidEventId);
    }
    if request.created_at.trim().is_empty() {
        return Err(LedgerError::InvalidTimestamp);
    }
    Ok(())
}

fn request_matches_event(request: &LedgerAppendRequest, event: &LedgerEvent) -> bool {
    request.event_id == event.event_id
        && request.session_id == event.session_id
        && request.context_scope_id == event.context_scope_id
        && request.turn_id == event.turn_id
        && request.created_at == event.created_at
        && request.r#type == event.r#type
        && request.payload == event.payload
}

fn validate_replay_identity(
    session_id: &SessionId,
    event: &LedgerEvent,
) -> Result<(), ReplayViolation> {
    if event.schema_version != CONTEXT_SCHEMA_VERSION {
        return Err(ReplayViolation::SchemaVersion(event.schema_version));
    }
    if event.session_id != session_id.as_str() {
        return Err(ReplayViolation::SessionMismatch);
    }
    if event.event_id.trim().is_empty() || event.event_id.len() > 256 {
        return Err(ReplayViolation::InvalidEventId);
    }
    if event.created_at.trim().is_empty() {
        return Err(ReplayViolation::EmptyTimestamp);
    }
    if event.sequence == 0 {
        return Err(ReplayViolation::ZeroSequence);
    }
    Ok(())
}

fn validate_snapshot(
    session_id: &SessionId,
    snapshot: &SessionRuntimeSnapshot,
    path: &Path,
) -> Result<(), LedgerError> {
    let violation = if snapshot.schema_version != CONTEXT_SCHEMA_VERSION {
        Some(SnapshotViolation::SchemaVersion(snapshot.schema_version))
    } else if snapshot.session_id != session_id.as_str() {
        Some(SnapshotViolation::SessionMismatch)
    } else if snapshot.created_at.trim().is_empty() {
        Some(SnapshotViolation::EmptyTimestamp)
    } else {
        snapshot.scopes.iter().find_map(|(scope_id, scope)| {
            let parsed = ContextScopeId::parse(scope_id).ok();
            if parsed.as_ref().map(ContextScopeId::as_key).as_deref() != Some(scope_id.as_str()) {
                return Some(SnapshotViolation::InvalidScope(scope_id.clone()));
            }
            if scope.history_version > snapshot.through_sequence {
                return Some(SnapshotViolation::HistoryVersionAhead);
            }
            if scope.active_messages.iter().any(|message| {
                message
                    .source_sequence
                    .is_some_and(|sequence| sequence > snapshot.through_sequence)
            }) {
                return Some(SnapshotViolation::MessageSequenceAhead);
            }
            if scope
                .resume_state
                .as_ref()
                .is_some_and(|resume| resume.covered_through_sequence > snapshot.through_sequence)
            {
                return Some(SnapshotViolation::ResumeSequenceAhead);
            }
            if scope
                .skill_states
                .iter()
                .chain(scope.post_compaction_skill_states.iter())
                .flatten()
                .any(|skill| skill.updated_sequence > snapshot.through_sequence)
            {
                return Some(SnapshotViolation::SkillSequenceAhead);
            }
            if scope
                .post_compaction_file_context
                .as_ref()
                .and_then(|context| context.source_sequence)
                .is_some_and(|sequence| sequence > snapshot.through_sequence)
                || scope
                    .post_compaction_skill_context
                    .as_ref()
                    .and_then(|context| context.source_sequence)
                    .is_some_and(|sequence| sequence > snapshot.through_sequence)
            {
                return Some(SnapshotViolation::ContextSequenceAhead);
            }
            None
        })
    };
    violation.map_or(Ok(()), |reason| {
        Err(LedgerError::InvalidSnapshot {
            path: path.to_path_buf(),
            reason,
        })
    })
}

fn derive_missing_skill_states(runtime: &mut LoadedSessionRuntime) {
    for scope in runtime.snapshot.scopes.values_mut() {
        if scope.skill_states.is_none() {
            scope.skill_states = Some(crate::context::skill_state::derive_session_skill_states(
                &scope.active_messages,
            ));
        }
    }
}

fn empty_runtime(session_id: &SessionId) -> LoadedSessionRuntime {
    LoadedSessionRuntime {
        snapshot: SessionRuntimeSnapshot {
            schema_version: CONTEXT_SCHEMA_VERSION,
            session_id: session_id.as_str().to_string(),
            through_sequence: 0,
            created_at: now_timestamp(),
            scopes: HashMap::new(),
        },
        warnings: Vec::new(),
    }
}

fn now_timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn violation_code(violation: &ReplayViolation) -> &'static str {
    match violation {
        ReplayViolation::SchemaVersion(_) => "schema",
        ReplayViolation::SessionMismatch => "session",
        ReplayViolation::InvalidEventId => "event-id",
        ReplayViolation::EmptyTimestamp => "timestamp",
        ReplayViolation::ZeroSequence => "zero-sequence",
        ReplayViolation::NonMonotonicSequence => "sequence-order",
        ReplayViolation::SequenceGap => "sequence-gap",
        ReplayViolation::HistoryVersion => "history-version",
        ReplayViolation::DuplicateEventId => "duplicate-id",
        ReplayViolation::InvalidPayload => "payload",
    }
}

fn prepare_session_directory_blocking(
    runtime_root: &Path,
    session_directory: &Path,
    create: bool,
) -> Result<bool, LedgerError> {
    if !validate_directory(runtime_root, create)? {
        return Ok(false);
    }
    match fs::symlink_metadata(session_directory) {
        Ok(metadata) if unsafe_directory_metadata(&metadata) => Err(LedgerError::UnsafeDirectory(
            session_directory.to_path_buf(),
        )),
        Ok(_) => Ok(true),
        Err(source) if source.kind() == io::ErrorKind::NotFound && !create => Ok(false),
        Err(source) if source.kind() == io::ErrorKind::NotFound => {
            match fs::create_dir(session_directory) {
                Ok(()) => {}
                Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {}
                Err(source) => {
                    return Err(directory_io(
                        "create session directory",
                        session_directory,
                        source,
                    ));
                }
            }
            let metadata = fs::symlink_metadata(session_directory).map_err(|source| {
                directory_io(
                    "inspect created session directory",
                    session_directory,
                    source,
                )
            })?;
            if unsafe_directory_metadata(&metadata) {
                Err(LedgerError::UnsafeDirectory(
                    session_directory.to_path_buf(),
                ))
            } else {
                Ok(true)
            }
        }
        Err(source) => Err(directory_io(
            "inspect session directory",
            session_directory,
            source,
        )),
    }
}

fn remove_session_directory_blocking(
    runtime_root: &Path,
    session_directory: &Path,
) -> Result<bool, LedgerError> {
    if !validate_directory(runtime_root, false)? {
        return Ok(false);
    }
    match fs::symlink_metadata(session_directory) {
        Ok(metadata) if unsafe_directory_metadata(&metadata) => Err(LedgerError::UnsafeDirectory(
            session_directory.to_path_buf(),
        )),
        Ok(_) => fs::remove_dir_all(session_directory)
            .map(|()| true)
            .map_err(|source| {
                directory_io(
                    "remove session runtime directory",
                    session_directory,
                    source,
                )
            }),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(directory_io(
            "inspect session runtime directory for removal",
            session_directory,
            source,
        )),
    }
}

fn validate_directory(path: &Path, create: bool) -> Result<bool, LedgerError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if unsafe_directory_metadata(&metadata) => {
            Err(LedgerError::UnsafeDirectory(path.to_path_buf()))
        }
        Ok(_) => Ok(true),
        Err(source) if source.kind() == io::ErrorKind::NotFound && !create => Ok(false),
        Err(source) if source.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(path)
                .map_err(|source| directory_io("create runtime directory", path, source))?;
            let metadata = fs::symlink_metadata(path)
                .map_err(|source| directory_io("inspect runtime directory", path, source))?;
            if unsafe_directory_metadata(&metadata) {
                Err(LedgerError::UnsafeDirectory(path.to_path_buf()))
            } else {
                Ok(true)
            }
        }
        Err(source) => Err(directory_io("inspect runtime directory", path, source)),
    }
}

fn unsafe_directory_metadata(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink() || !metadata.is_dir() || is_reparse_point(metadata)
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
const fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn directory_io(operation: &'static str, path: &Path, source: io::Error) -> LedgerError {
    LedgerError::DirectoryIo {
        operation,
        path: path.to_path_buf(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::{self, Write as _},
        path::Path,
        sync::Arc,
    };

    use codez_core::context::{
        ContextScopeId, LedgerAppendRequest, LedgerEventType, NormalizedModelMessage,
    };
    use codez_core::{
        AppError, AppErrorKind, AtomicCreateOutcome, AtomicPersistence, PortFuture, SessionId,
    };
    use tokio::io::AsyncWriteExt;

    use super::{
        INVALID_SUFFIX_WARNING, LedgerError, MALFORMED_SUFFIX_WARNING, ModelLedgerStore,
        SnapshotViolation,
    };

    #[derive(Debug, Default)]
    struct TestAtomicPersistence;

    impl AtomicPersistence for TestAtomicPersistence {
        fn read<'a>(&'a self, path: &'a Path) -> PortFuture<'a, Option<Vec<u8>>> {
            Box::pin(async move {
                match tokio::fs::read(path).await {
                    Ok(bytes) => Ok(Some(bytes)),
                    Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(None),
                    Err(source) => Err(test_persistence_error("read", path, source)),
                }
            })
        }

        fn replace<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
            Box::pin(async move {
                create_parent(path).await?;
                tokio::fs::write(path, bytes)
                    .await
                    .map_err(|source| test_persistence_error("replace", path, source))
            })
        }

        fn create_no_clobber<'a>(
            &'a self,
            path: &'a Path,
            bytes: &'a [u8],
        ) -> PortFuture<'a, AtomicCreateOutcome> {
            Box::pin(async move {
                create_parent(path).await?;
                match tokio::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)
                    .await
                {
                    Ok(mut file) => {
                        file.write_all(bytes).await.map_err(|source| {
                            test_persistence_error("write no-clobber target", path, source)
                        })?;
                        file.flush().await.map_err(|source| {
                            test_persistence_error("flush no-clobber target", path, source)
                        })?;
                        Ok(AtomicCreateOutcome::Created)
                    }
                    Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {
                        let existing = tokio::fs::read(path).await.map_err(|source| {
                            test_persistence_error("read no-clobber target", path, source)
                        })?;
                        if existing == bytes {
                            Ok(AtomicCreateOutcome::Reused)
                        } else {
                            Err(AppError::conflict(
                                "The test persistence target already contains different bytes",
                            ))
                        }
                    }
                    Err(source) => Err(test_persistence_error(
                        "create no-clobber target",
                        path,
                        source,
                    )),
                }
            })
        }

        fn append<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
            Box::pin(async move {
                create_parent(path).await?;
                let mut file = tokio::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
                    .await
                    .map_err(|source| test_persistence_error("open append target", path, source))?;
                file.write_all(bytes)
                    .await
                    .map_err(|source| test_persistence_error("append", path, source))?;
                file.flush()
                    .await
                    .map_err(|source| test_persistence_error("flush append target", path, source))
            })
        }

        fn remove<'a>(&'a self, path: &'a Path) -> PortFuture<'a, bool> {
            Box::pin(async move {
                match tokio::fs::remove_file(path).await {
                    Ok(()) => Ok(true),
                    Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(false),
                    Err(source) => Err(test_persistence_error("remove", path, source)),
                }
            })
        }
    }

    fn ledger_store(root: &Path) -> ModelLedgerStore {
        ModelLedgerStore::new(root, Arc::new(TestAtomicPersistence))
    }

    async fn create_parent(path: &Path) -> Result<(), AppError> {
        let parent = path
            .parent()
            .ok_or_else(|| AppError::validation("The test persistence path has no parent"))?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|source| test_persistence_error("create parent", path, source))
    }

    fn test_persistence_error(operation: &str, path: &Path, source: io::Error) -> AppError {
        AppError::storage(
            "The test persistence operation failed",
            format!("{operation} {}: {source}", path.display()),
            false,
        )
    }

    fn request(session_id: &str, event_id: &str, message_id: &str) -> LedgerAppendRequest {
        LedgerAppendRequest {
            event_id: event_id.to_string(),
            session_id: session_id.to_string(),
            context_scope_id: ContextScopeId::Main,
            turn_id: Some("turn-1".to_string()),
            created_at: "2026-07-16T00:00:00.000Z".to_string(),
            r#type: LedgerEventType::UserMessage,
            payload: serde_json::json!({
                "message": message(message_id, "user"),
                "providerId": "provider-1",
                "model": "model-1"
            }),
        }
    }

    fn message(id: &str, role: &str) -> NormalizedModelMessage {
        NormalizedModelMessage {
            id: id.to_string(),
            client_message_id: None,
            turn_id: "turn-1".to_string(),
            role: role.to_string(),
            content: format!("message {id}"),
            tool_calls: None,
            tool_call_id: None,
            name: None,
            status: "complete".to_string(),
            created_at: "2026-07-16T00:00:00.000Z".to_string(),
            source_sequence: None,
            attachments: None,
            file_references: None,
        }
    }

    fn request_with_ui_message(
        session_id: &str,
        event_id: &str,
        message_id: &str,
        ui_message_id: &str,
        persist_on_message: bool,
    ) -> LedgerAppendRequest {
        let mut request = request(session_id, event_id, message_id);
        if persist_on_message {
            request.payload["message"]["clientMessageId"] =
                serde_json::Value::String(ui_message_id.to_string());
        } else {
            request.payload["commandMetadata"] = serde_json::json!({
                "uiMessageId": ui_message_id,
            });
        }
        request
    }

    #[tokio::test]
    async fn concurrent_appends_share_one_monotonic_session_sequence() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let root = directory.path().join("runtime");
        let stores = [Arc::new(ledger_store(&root)), Arc::new(ledger_store(&root))];
        let mut tasks = Vec::new();
        for index in 0..24 {
            let store = Arc::clone(&stores[index % stores.len()]);
            tasks.push(tokio::spawn(async move {
                store
                    .append_event(request(
                        "session-1",
                        &format!("event-{index}"),
                        &format!("message-{index}"),
                    ))
                    .await
            }));
        }
        let mut sequences = Vec::new();
        for task in tasks {
            sequences.push(
                task.await
                    .expect("ledger task must join")
                    .expect("ledger append must succeed")
                    .sequence,
            );
        }
        sequences.sort_unstable();

        assert_eq!(sequences, (1..=24).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn delete_session_removes_durable_history_and_invalidates_the_cache() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let root = directory.path().join("runtime");
        let store = ledger_store(&root);
        let session_id = SessionId::parse("session-1").expect("fixture session ID must be valid");

        store
            .append_event(request("session-1", "event-1", "message-1"))
            .await
            .expect("fixture history must persist");
        assert!(
            store
                .get_snapshot(&session_id)
                .await
                .expect("fixture history must load")
                .is_some()
        );

        assert!(
            store
                .delete_session(&session_id)
                .await
                .expect("session history must delete")
        );
        assert!(!store.session_directory(&session_id).exists());
        assert!(
            store
                .get_snapshot(&session_id)
                .await
                .expect("deleted history lookup must succeed")
                .is_none()
        );
    }

    #[tokio::test]
    async fn history_revert_plan_keeps_only_messages_before_the_ui_target() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = ledger_store(&directory.path().join("runtime"));
        let session_id = SessionId::parse("session-1").expect("fixture session ID must be valid");
        store
            .append_event(request_with_ui_message(
                "session-1",
                "event-1",
                "message-1",
                "ui-message-1",
                true,
            ))
            .await
            .expect("first fixture message must persist");
        store
            .append_event(request_with_ui_message(
                "session-1",
                "event-2",
                "message-2",
                "ui-message-2",
                true,
            ))
            .await
            .expect("target fixture message must persist");

        let plan = store
            .plan_history_revert(&session_id, &ContextScopeId::Main, "ui-message-2")
            .await
            .expect("the active target must produce a revert plan");

        assert_eq!(
            (
                plan.expected_history_version,
                plan.payload.target_message_id.as_str(),
                plan.payload
                    .active_messages
                    .iter()
                    .map(|message| message.id.as_str())
                    .collect::<Vec<_>>(),
            ),
            (2, "message-2", vec!["message-1"])
        );
    }

    #[tokio::test]
    async fn history_revert_plan_recovers_ui_identity_from_event_metadata() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = ledger_store(&directory.path().join("runtime"));
        let session_id = SessionId::parse("session-1").expect("fixture session ID must be valid");
        store
            .append_event(request_with_ui_message(
                "session-1",
                "event-1",
                "message-1",
                "ui-message-1",
                false,
            ))
            .await
            .expect("fixture message metadata must persist");

        let plan = store
            .plan_history_revert(&session_id, &ContextScopeId::Main, "ui-message-1")
            .await
            .expect("event metadata must remain a supported lookup path");

        assert_eq!(plan.payload.target_message_id, "message-1");
    }

    #[tokio::test]
    async fn identical_event_retries_are_idempotent_after_restart() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let root = directory.path().join("runtime");
        let first = ledger_store(&root);
        let request = request("session-1", "event-1", "message-1");
        let appended = first
            .append_event(request.clone())
            .await
            .expect("first append must succeed");
        drop(first);
        let restarted = ledger_store(&root);
        let retried = restarted
            .append_event(request)
            .await
            .expect("identical retry must succeed");
        let session_id = SessionId::parse("session-1").expect("fixture id must be valid");
        let bytes = fs::read_to_string(restarted.ledger_path(&session_id))
            .expect("ledger must remain readable");

        assert_eq!((retried, bytes.lines().count()), (appended, 1));
    }

    #[tokio::test]
    async fn restart_replays_messages_from_the_durable_ledger() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let root = directory.path().join("runtime");
        ledger_store(&root)
            .append_event(request("session-1", "event-1", "message-1"))
            .await
            .expect("fixture append must succeed");
        let restarted = ledger_store(&root);
        let session_id = SessionId::parse("session-1").expect("fixture id must be valid");
        let snapshot = restarted
            .get_snapshot(&session_id)
            .await
            .expect("restart replay must succeed")
            .expect("runtime must exist");

        assert_eq!(snapshot.scopes["main"].active_messages[0].id, "message-1");
    }

    #[tokio::test]
    async fn snapshot_and_tail_replay_restore_the_latest_sequence() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let root = directory.path().join("runtime");
        let store = ledger_store(&root);
        let session_id = SessionId::parse("session-1").expect("fixture id must be valid");
        store
            .append_event(request("session-1", "event-1", "message-1"))
            .await
            .expect("first append must succeed");
        store
            .write_snapshot(&session_id)
            .await
            .expect("snapshot write must succeed");
        store
            .append_event(request("session-1", "event-2", "message-2"))
            .await
            .expect("tail append must succeed");
        let restored = ledger_store(&root)
            .get_snapshot(&session_id)
            .await
            .expect("snapshot replay must succeed")
            .expect("runtime must exist");

        assert_eq!(
            (
                restored.through_sequence,
                restored.scopes["main"].active_messages.len()
            ),
            (2, 2)
        );
    }

    #[tokio::test]
    async fn truncated_jsonl_suffix_is_quarantined_and_not_replayed() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let root = directory.path().join("runtime");
        let first = ledger_store(&root);
        let session_id = SessionId::parse("session-1").expect("fixture id must be valid");
        first
            .append_event(request("session-1", "event-1", "message-1"))
            .await
            .expect("fixture append must succeed");
        fs::OpenOptions::new()
            .append(true)
            .open(first.ledger_path(&session_id))
            .expect("ledger must open")
            .write_all(b"{\"schemaVersion\":1")
            .expect("truncated fixture must be written");
        drop(first);

        let loaded = ledger_store(&root)
            .load(&session_id)
            .await
            .expect("truncated suffix recovery must succeed")
            .expect("runtime must exist");

        assert_eq!(loaded.snapshot.through_sequence, 1);
        assert!(
            loaded
                .warnings
                .iter()
                .any(|warning| warning == MALFORMED_SUFFIX_WARNING)
        );
    }

    #[tokio::test]
    async fn sequence_gap_suffix_is_isolated_from_the_active_ledger() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let root = directory.path().join("runtime");
        let first = ledger_store(&root);
        let session_id = SessionId::parse("session-1").expect("fixture id must be valid");
        let mut gap = first
            .append_event(request("session-1", "event-1", "message-1"))
            .await
            .expect("fixture append must succeed");
        gap.event_id = "event-3".to_string();
        gap.sequence = 3;
        gap.history_version = 2;
        let line = serde_json::to_string(&gap).expect("gap fixture must serialize");
        writeln!(
            fs::OpenOptions::new()
                .append(true)
                .open(first.ledger_path(&session_id))
                .expect("ledger must open"),
            "{line}"
        )
        .expect("gap fixture must be written");
        drop(first);

        let restarted = ledger_store(&root);
        let loaded = restarted
            .load(&session_id)
            .await
            .expect("semantic suffix recovery must succeed")
            .expect("runtime must exist");
        let active_lines = fs::read_to_string(restarted.ledger_path(&session_id))
            .expect("active ledger must remain readable")
            .lines()
            .count();

        assert_eq!((loaded.snapshot.through_sequence, active_lines), (1, 1));
        assert!(
            loaded
                .warnings
                .iter()
                .any(|warning| warning == INVALID_SUFFIX_WARNING)
        );
    }

    #[tokio::test]
    async fn traversal_session_id_is_rejected_before_any_path_is_created() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let root = directory.path().join("runtime");
        let mut invalid = request("session-1", "event-1", "message-1");
        invalid.session_id = "../outside".to_string();

        let error = ledger_store(&root)
            .append_event(invalid)
            .await
            .expect_err("path traversal must be rejected");

        assert!(matches!(error, LedgerError::InvalidSessionId(_)));
        assert!(!directory.path().join("outside").exists());
    }

    #[test]
    fn ledger_failures_map_to_stable_application_error_categories() {
        let validation = AppError::from(LedgerError::InvalidTimestamp);
        let storage = AppError::from(LedgerError::UnsafeDirectory("unsafe".into()));

        assert_eq!(
            (validation.kind(), storage.kind()),
            (AppErrorKind::Validation, AppErrorKind::Storage)
        );
    }

    #[tokio::test]
    async fn invalid_snapshot_schema_is_rejected_before_tail_replay() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let root = directory.path().join("runtime");
        let session_id = SessionId::parse("session-1").expect("fixture id must be valid");
        let session_directory = root.join(session_id.as_str());
        fs::create_dir_all(&session_directory).expect("fixture directory must be created");
        fs::write(
            session_directory.join("snapshot.json"),
            r#"{"schemaVersion":99,"sessionId":"session-1","throughSequence":0,"createdAt":"now","scopes":{}}"#,
        )
        .expect("invalid snapshot fixture must be written");

        let error = ledger_store(&root)
            .get_snapshot(&session_id)
            .await
            .expect_err("unsupported snapshot schema must fail");

        assert!(matches!(
            error,
            LedgerError::InvalidSnapshot {
                reason: SnapshotViolation::SchemaVersion(99),
                ..
            }
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinked_session_directory_is_rejected() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let root = directory.path().join("runtime");
        let outside = directory.path().join("outside");
        fs::create_dir_all(&root).expect("runtime root must be created");
        fs::create_dir_all(&outside).expect("outside directory must be created");
        symlink(&outside, root.join("session-1")).expect("fixture symlink must be created");

        let error = ledger_store(&root)
            .append_event(request("session-1", "event-1", "message-1"))
            .await
            .expect_err("symlink escape must be rejected");

        assert!(matches!(error, LedgerError::UnsafeDirectory(_)));
    }
}
