use std::{fmt, sync::Arc};

use async_trait::async_trait;
use chrono::{SecondsFormat, Utc};
use codez_core::{
    IdentifierError, SessionId,
    context::{
        CompactionCompletedPayload, CompactionFailedPayload, CompactionStartedPayload,
        ContextScopeId, LedgerAppendRequest, LedgerEventType, NormalizedModelMessage,
        PostCompactionFileContext, PostCompactionSkillContext, SessionSkillState,
        VersionedResumeState,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::context::{
    budget::{ContextBudgetService, ModelContextCapabilities},
    ledger::{LedgerError, ModelLedgerStore},
};

const DEFAULT_MAX_SUMMARY_CHARS: usize = 96_000;
const MAX_FAILURE_MESSAGE_CHARS: usize = 4_096;
const TAIL_BUDGET_DIVISOR: u32 = 4;

/// Input required to compact one durable context scope.
pub struct CompactionRequest {
    pub session_id: String,
    pub context_scope_id: ContextScopeId,
    pub trigger: String,
    pub capabilities: ModelContextCapabilities,
    pub system_prompt: String,
    pub manual_instructions: Option<String>,
    pub workspace_root: Option<String>,
    pub reasoning_budget_tokens: Option<u32>,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub required_message_id: Option<String>,
}

/// Durable history supplied to a compaction model adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionSummaryInput {
    pub session_id: String,
    pub context_scope_id: ContextScopeId,
    pub source_history_version: u32,
    pub covered_through_sequence: u32,
    pub messages: Vec<NormalizedModelMessage>,
    pub previous_summary: Option<serde_json::Value>,
    pub resume_state: Option<VersionedResumeState>,
    pub system_prompt: String,
    pub manual_instructions: Option<String>,
    pub workspace_root: Option<String>,
    pub provider_id: Option<String>,
    pub model: Option<String>,
}

/// Adapter boundary used to generate a summary without coupling the runtime to a provider.
#[async_trait]
pub trait CompactionSummarizer: Send + Sync {
    /// Produces a concise, durable continuation summary for the supplied history prefix.
    async fn summarize(
        &self,
        input: CompactionSummaryInput,
    ) -> Result<String, CompactionSummarizerError>;
}

/// A provider adapter's explicit failure to generate a usable summary.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CompactionSummarizerError {
    #[error("{message}")]
    Generation { message: String, retryable: bool },
}

impl CompactionSummarizerError {
    /// Constructs a retryable or terminal provider generation failure.
    #[must_use]
    pub fn generation(message: impl Into<String>, retryable: bool) -> Self {
        Self::Generation {
            message: message.into(),
            retryable,
        }
    }

    const fn retryable(&self) -> bool {
        match self {
            Self::Generation { retryable, .. } => *retryable,
        }
    }
}

/// Final outcome of a compaction attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionStatus {
    Completed,
    Failed,
}

/// Indicates whether the latest completed ledger state has an atomic snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionSnapshotStatus {
    Committed,
    Deferred,
}

/// Stable reason attached to a durable `CompactionFailed` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CompactionFailureCode {
    #[serde(rename = "COMPACTION_INSUFFICIENT_HISTORY")]
    InsufficientHistory,
    #[serde(rename = "COMPACTION_SCHEMA_INVALID")]
    SchemaInvalid,
    #[serde(rename = "COMPACTION_SUMMARY_FAILED")]
    SummaryFailed,
    #[serde(rename = "COMPACTION_INSUFFICIENT_REDUCTION")]
    InsufficientReduction,
    #[serde(rename = "COMPACTION_STALE_VERSION")]
    StaleHistory,
    #[serde(rename = "COMPACTION_PERSISTENCE_FAILED")]
    PersistenceFailed,
}

impl CompactionFailureCode {
    /// Returns the stable wire value shared by result and ledger failure payloads.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InsufficientHistory => "COMPACTION_INSUFFICIENT_HISTORY",
            Self::SchemaInvalid => "COMPACTION_SCHEMA_INVALID",
            Self::SummaryFailed => "COMPACTION_SUMMARY_FAILED",
            Self::InsufficientReduction => "COMPACTION_INSUFFICIENT_REDUCTION",
            Self::StaleHistory => "COMPACTION_STALE_VERSION",
            Self::PersistenceFailed => "COMPACTION_PERSISTENCE_FAILED",
        }
    }
}

impl fmt::Display for CompactionFailureCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// The externally observable result after either a completed or failed ledger transition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionResult {
    pub status: CompactionStatus,
    pub error_code: Option<CompactionFailureCode>,
    pub message: Option<String>,
    pub tokens_before: Option<u32>,
    pub tokens_after: Option<u32>,
    pub snapshot_status: Option<CompactionSnapshotStatus>,
    pub history_version: Option<u32>,
}

/// Phase that failed while a compaction attempt was being recorded.
#[derive(Debug, Clone, Copy)]
pub enum CompactionStage {
    /// Loading the recoverable ledger state.
    Load,
    /// Validating history, a generated summary, or the resulting budget.
    Validate,
    /// Calling the provider-backed summary adapter.
    Summarize,
    /// Persisting a `CompactionStarted`, `CompactionCompleted`, or failure event.
    Commit,
}

impl CompactionStage {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Load => "load",
            Self::Validate => "validate",
            Self::Summarize => "summarize",
            Self::Commit => "commit",
        }
    }
}

impl fmt::Display for CompactionStage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Typed failures that cannot be represented by a durable `CompactionFailed` event.
#[derive(Debug, Error)]
pub enum CompactionError {
    #[error("compaction session id cannot be empty")]
    EmptySessionId,
    #[error("invalid compaction session identifier: {0}")]
    InvalidSessionId(#[from] IdentifierError),
    #[error("compaction {stage} payload could not be serialized: {source}")]
    PayloadSerialization {
        stage: CompactionStage,
        #[source]
        source: serde_json::Error,
    },
    #[error("context ledger failed during compaction {stage}: {source}")]
    Ledger {
        stage: CompactionStage,
        #[source]
        source: LedgerError,
    },
    #[error("compaction {code} failure could not be persisted at {stage}: {source}")]
    FailurePersistence {
        stage: CompactionStage,
        code: CompactionFailureCode,
        #[source]
        source: LedgerError,
    },
}

struct CompactionCandidate {
    source_history_version: u32,
    covered_through_sequence: u32,
    tokens_before: u32,
    head: Vec<NormalizedModelMessage>,
    retained_messages: Vec<NormalizedModelMessage>,
    previous_summary: Option<serde_json::Value>,
    resume_state: Option<VersionedResumeState>,
    post_compaction_file_context: Option<PostCompactionFileContext>,
    post_compaction_skill_context: Option<PostCompactionSkillContext>,
    skill_states: Option<Vec<SessionSkillState>>,
    post_compaction_skill_states: Option<Vec<SessionSkillState>>,
}

struct ValidatedSummary {
    persisted: serde_json::Value,
}

#[derive(Debug, Error)]
enum SummaryValidationError {
    #[error("summary is empty")]
    Empty,
    #[error("summary exceeds the configured limit of {limit} characters")]
    TooLarge { limit: usize },
    #[error("summary could not be serialized: {0}")]
    Serialization(#[source] serde_json::Error),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextCompactionSummary<'a> {
    version: u8,
    format: &'static str,
    content: &'a str,
    covered_through_sequence: u32,
}

/// Crash-recoverable compaction coordinator over the context ledger.
pub struct CompactionService {
    ledger: ModelLedgerStore,
    summarizer: Arc<dyn CompactionSummarizer>,
    max_summary_chars: usize,
}

impl CompactionService {
    /// Creates a compaction service that persists all state through `ledger`.
    #[must_use]
    pub fn new(ledger: ModelLedgerStore, summarizer: Arc<dyn CompactionSummarizer>) -> Self {
        Self {
            ledger,
            summarizer,
            max_summary_chars: DEFAULT_MAX_SUMMARY_CHARS,
        }
    }

    /// Configures the maximum accepted character count for generated summaries.
    #[must_use]
    pub fn with_max_summary_chars(mut self, max_summary_chars: usize) -> Self {
        self.max_summary_chars = max_summary_chars.max(1);
        self
    }

    /// Compacts one context scope without overwriting history derived by another writer.
    ///
    /// A completed result is only returned after `CompactionCompleted` is durably appended.
    /// Snapshot persistence may be deferred because the ledger remains the recoverable source of
    /// truth until the next snapshot succeeds.
    ///
    /// # Errors
    ///
    /// Returns [`CompactionError`] when the request identity is invalid, the ledger cannot be
    /// read, or a durable failure event cannot be recorded. Domain and provider failures are
    /// returned as [`CompactionStatus::Failed`] after their `CompactionFailed` event is durable.
    pub async fn compact(
        &self,
        request: CompactionRequest,
    ) -> Result<CompactionResult, CompactionError> {
        if request.session_id.trim().is_empty() {
            return Err(CompactionError::EmptySessionId);
        }
        let session_id = SessionId::parse(request.session_id.clone())?;
        let loaded =
            self.ledger
                .load(&session_id)
                .await
                .map_err(|source| CompactionError::Ledger {
                    stage: CompactionStage::Load,
                    source,
                })?;

        let Some(loaded) = loaded else {
            return self
                .record_failure(
                    &session_id,
                    &request,
                    CompactionStage::Load,
                    CompactionFailureCode::InsufficientHistory,
                    "No session history is available to compact",
                    false,
                )
                .await;
        };
        let scope_key = request.context_scope_id.as_key();
        let Some(scope) = loaded.snapshot.scopes.get(scope_key.as_ref()) else {
            return self
                .record_failure(
                    &session_id,
                    &request,
                    CompactionStage::Load,
                    CompactionFailureCode::InsufficientHistory,
                    "The requested context scope has no history to compact",
                    false,
                )
                .await;
        };
        if scope.active_messages.is_empty() {
            return self
                .record_failure(
                    &session_id,
                    &request,
                    CompactionStage::Load,
                    CompactionFailureCode::InsufficientHistory,
                    "No model-visible history is available to compact",
                    false,
                )
                .await;
        }

        let limits = ContextBudgetService::resolve_limits(
            &request.capabilities,
            request.reasoning_budget_tokens.unwrap_or(0),
        );
        let tail_budget = (limits.usable_input_budget / TAIL_BUDGET_DIVISOR).max(1);
        let tail_start = select_tail_start(
            &scope.active_messages,
            tail_budget,
            request.required_message_id.as_deref(),
        );
        if tail_start == 0 {
            return self
                .record_failure(
                    &session_id,
                    &request,
                    CompactionStage::Validate,
                    CompactionFailureCode::InsufficientHistory,
                    "No history prefix can be compacted while retaining the required tail",
                    false,
                )
                .await;
        }

        let head = scope.active_messages[..tail_start].to_vec();
        let retained_messages = scope.active_messages[tail_start..].to_vec();
        let Some(covered_through_sequence) =
            head.last().and_then(|message| message.source_sequence)
        else {
            return self
                .record_failure(
                    &session_id,
                    &request,
                    CompactionStage::Validate,
                    CompactionFailureCode::SchemaInvalid,
                    "The compaction boundary has no durable ledger sequence",
                    false,
                )
                .await;
        };
        let candidate = CompactionCandidate {
            source_history_version: scope.history_version,
            covered_through_sequence,
            tokens_before: estimate_context_tokens(
                &request,
                &scope.active_messages,
                scope.latest_compaction.as_ref(),
            ),
            head,
            retained_messages,
            previous_summary: scope.latest_compaction.clone(),
            resume_state: scope.resume_state.clone(),
            post_compaction_file_context: scope.post_compaction_file_context.clone(),
            post_compaction_skill_context: scope.post_compaction_skill_context.clone(),
            skill_states: scope.skill_states.clone(),
            post_compaction_skill_states: scope.post_compaction_skill_states.clone(),
        };

        let started_payload = CompactionStartedPayload {
            trigger: request.trigger.clone(),
            source_history_version: candidate.source_history_version,
            candidate_through_sequence: candidate.covered_through_sequence,
            tokens_before: candidate.tokens_before,
        };
        let started = self
            .ledger
            .append_event_for(
                &session_id,
                ledger_request(
                    &session_id,
                    &request,
                    LedgerEventType::CompactionStarted,
                    serialize_payload(CompactionStage::Commit, &started_payload)?,
                ),
            )
            .await
            .map_err(|source| CompactionError::Ledger {
                stage: CompactionStage::Commit,
                source,
            })?;
        if started.history_version != candidate.source_history_version {
            return self
                .record_failure(
                    &session_id,
                    &request,
                    CompactionStage::Commit,
                    CompactionFailureCode::StaleHistory,
                    "History changed before compaction summary generation began",
                    true,
                )
                .await;
        }

        let generated = self
            .summarizer
            .summarize(CompactionSummaryInput {
                session_id: session_id.as_str().to_string(),
                context_scope_id: request.context_scope_id.clone(),
                source_history_version: candidate.source_history_version,
                covered_through_sequence: candidate.covered_through_sequence,
                messages: candidate.head.clone(),
                previous_summary: candidate.previous_summary.clone(),
                resume_state: candidate.resume_state.clone(),
                system_prompt: request.system_prompt.clone(),
                manual_instructions: request.manual_instructions.clone(),
                workspace_root: request.workspace_root.clone(),
                provider_id: request.provider_id.clone(),
                model: request.model.clone(),
            })
            .await;
        let summary = match generated {
            Ok(summary) => match validate_summary(
                summary,
                candidate.covered_through_sequence,
                self.max_summary_chars,
            ) {
                Ok(summary) => summary,
                Err(source) => {
                    return self
                        .record_failure(
                            &session_id,
                            &request,
                            CompactionStage::Validate,
                            CompactionFailureCode::SchemaInvalid,
                            source.to_string(),
                            true,
                        )
                        .await;
                }
            },
            Err(source) => {
                return self
                    .record_failure(
                        &session_id,
                        &request,
                        CompactionStage::Summarize,
                        CompactionFailureCode::SummaryFailed,
                        source.to_string(),
                        source.retryable(),
                    )
                    .await;
            }
        };

        let tokens_after = estimate_context_tokens(
            &request,
            &candidate.retained_messages,
            Some(&summary.persisted),
        );
        if tokens_after > limits.hard_input_limit {
            return self
                .record_failure(
                    &session_id,
                    &request,
                    CompactionStage::Validate,
                    CompactionFailureCode::InsufficientReduction,
                    "The compacted context still exceeds the model hard input limit",
                    true,
                )
                .await;
        }
        if tokens_after >= candidate.tokens_before {
            return self
                .record_failure(
                    &session_id,
                    &request,
                    CompactionStage::Validate,
                    CompactionFailureCode::InsufficientReduction,
                    "The compacted context did not reduce the input budget",
                    true,
                )
                .await;
        }

        let source_hash = match source_hash(&candidate.head) {
            Ok(source_hash) => source_hash,
            Err(source) => {
                return self
                    .record_failure(
                        &session_id,
                        &request,
                        CompactionStage::Validate,
                        CompactionFailureCode::SchemaInvalid,
                        format!("The compaction source history could not be serialized: {source}"),
                        false,
                    )
                    .await;
            }
        };
        let completed_payload = CompactionCompletedPayload {
            trigger: request.trigger.clone(),
            source_history_version: candidate.source_history_version,
            covered_through_sequence: candidate.covered_through_sequence,
            retained_from_sequence: candidate
                .retained_messages
                .first()
                .and_then(|message| message.source_sequence),
            tokens_before: candidate.tokens_before,
            tokens_after,
            source_hash,
            summary: summary.persisted,
            observed_provider_input_limit: None,
            resume_state: candidate.resume_state,
            active_messages: candidate.retained_messages,
            post_compaction_file_context: candidate.post_compaction_file_context,
            post_compaction_skill_context: candidate.post_compaction_skill_context,
            skill_states: candidate.skill_states,
            post_compaction_skill_states: candidate.post_compaction_skill_states,
        };
        let completed = self
            .ledger
            .append_event_if_history_version(
                &session_id,
                candidate.source_history_version,
                ledger_request(
                    &session_id,
                    &request,
                    LedgerEventType::CompactionCompleted,
                    serialize_payload(CompactionStage::Commit, &completed_payload)?,
                ),
            )
            .await;
        let completed = match completed {
            Ok(event) => event,
            Err(LedgerError::HistoryVersionConflict { .. }) => {
                return self
                    .record_failure(
                        &session_id,
                        &request,
                        CompactionStage::Commit,
                        CompactionFailureCode::StaleHistory,
                        "History changed while the compaction summary was being generated",
                        true,
                    )
                    .await;
            }
            Err(source) => {
                return self
                    .record_failure(
                        &session_id,
                        &request,
                        CompactionStage::Commit,
                        CompactionFailureCode::PersistenceFailed,
                        format!("The completed compaction could not be persisted: {source}"),
                        true,
                    )
                    .await;
            }
        };

        let (snapshot_status, message) = match self.ledger.write_snapshot(&session_id).await {
            Ok(Some(_)) => (CompactionSnapshotStatus::Committed, None),
            Ok(None) => (
                CompactionSnapshotStatus::Deferred,
                Some("The completed ledger state has no snapshot yet".to_string()),
            ),
            Err(source) => (
                CompactionSnapshotStatus::Deferred,
                Some(bounded_failure_message(format!(
                    "The completed ledger state is recoverable, but its snapshot is deferred: {source}"
                ))),
            ),
        };
        Ok(CompactionResult {
            status: CompactionStatus::Completed,
            error_code: None,
            message,
            tokens_before: Some(candidate.tokens_before),
            tokens_after: Some(tokens_after),
            snapshot_status: Some(snapshot_status),
            history_version: Some(completed.history_version),
        })
    }

    async fn record_failure(
        &self,
        session_id: &SessionId,
        request: &CompactionRequest,
        stage: CompactionStage,
        code: CompactionFailureCode,
        message: impl Into<String>,
        retryable: bool,
    ) -> Result<CompactionResult, CompactionError> {
        let message = bounded_failure_message(message.into());
        let failed_payload = CompactionFailedPayload {
            trigger: request.trigger.clone(),
            stage: stage.as_str().to_string(),
            code: code.as_str().to_string(),
            message: message.clone(),
            retryable,
        };
        let event = self
            .ledger
            .append_event_for(
                session_id,
                ledger_request(
                    session_id,
                    request,
                    LedgerEventType::CompactionFailed,
                    serialize_payload(stage, &failed_payload)?,
                ),
            )
            .await
            .map_err(|source| CompactionError::FailurePersistence {
                stage,
                code,
                source,
            })?;
        Ok(CompactionResult {
            status: CompactionStatus::Failed,
            error_code: Some(code),
            message: Some(message),
            tokens_before: None,
            tokens_after: None,
            snapshot_status: None,
            history_version: Some(event.history_version),
        })
    }
}

fn ledger_request(
    session_id: &SessionId,
    request: &CompactionRequest,
    event_type: LedgerEventType,
    payload: serde_json::Value,
) -> LedgerAppendRequest {
    LedgerAppendRequest {
        event_id: format!("compaction-{}", Uuid::new_v4()),
        session_id: session_id.as_str().to_string(),
        context_scope_id: request.context_scope_id.clone(),
        turn_id: None,
        created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        r#type: event_type,
        payload,
    }
}

fn serialize_payload<T>(
    stage: CompactionStage,
    payload: &T,
) -> Result<serde_json::Value, CompactionError>
where
    T: Serialize,
{
    serde_json::to_value(payload)
        .map_err(|source| CompactionError::PayloadSerialization { stage, source })
}

fn select_tail_start(
    messages: &[NormalizedModelMessage],
    tail_budget: u32,
    required_message_id: Option<&str>,
) -> usize {
    let mut start = messages.len();
    let mut used_tokens: u32 = 0;
    for (index, message) in messages.iter().enumerate().rev() {
        let message_tokens = estimate_message_tokens(message);
        if start == messages.len() || used_tokens.saturating_add(message_tokens) <= tail_budget {
            used_tokens = used_tokens.saturating_add(message_tokens);
            start = index;
        } else {
            break;
        }
    }
    if let Some(required_message_id) = required_message_id {
        if let Some(required_index) = messages
            .iter()
            .position(|message| message.id == required_message_id)
        {
            start = start.min(required_index);
        }
    }
    start
}

fn estimate_context_tokens(
    request: &CompactionRequest,
    messages: &[NormalizedModelMessage],
    summary: Option<&serde_json::Value>,
) -> u32 {
    let system_tokens = ContextBudgetService::estimate_string_tokens(&request.system_prompt);
    let instruction_tokens = request
        .manual_instructions
        .as_deref()
        .map_or(0, |instructions| {
            ContextBudgetService::estimate_string_tokens(instructions)
        });
    let summary_tokens = summary.map_or(0, |summary| {
        ContextBudgetService::estimate_string_tokens(&summary.to_string())
    });
    let protocol_tokens = u32::try_from(messages.len())
        .unwrap_or(u32::MAX)
        .saturating_add(1)
        .saturating_mul(4);

    messages.iter().fold(
        system_tokens
            .saturating_add(instruction_tokens)
            .saturating_add(summary_tokens)
            .saturating_add(protocol_tokens),
        |total, message| total.saturating_add(estimate_message_tokens(message)),
    )
}

fn estimate_message_tokens(message: &NormalizedModelMessage) -> u32 {
    let metadata_tokens = [
        message.id.as_str(),
        message.turn_id.as_str(),
        message.role.as_str(),
        message.status.as_str(),
        message.created_at.as_str(),
    ]
    .into_iter()
    .fold(0_u32, |total, value| {
        total.saturating_add(ContextBudgetService::estimate_string_tokens(value))
    });
    let tool_tokens = message.tool_calls.as_deref().map_or(0, |calls| {
        calls.iter().fold(0_u32, |total, call| {
            total
                .saturating_add(ContextBudgetService::estimate_string_tokens(&call.id))
                .saturating_add(ContextBudgetService::estimate_string_tokens(&call.name))
                .saturating_add(ContextBudgetService::estimate_string_tokens(
                    &call.arguments,
                ))
                .saturating_add(call.thought_signature.as_deref().map_or(0, |signature| {
                    ContextBudgetService::estimate_string_tokens(signature)
                }))
        })
    });

    ContextBudgetService::estimate_string_tokens(&message.content)
        .saturating_add(metadata_tokens)
        .saturating_add(tool_tokens)
}

fn validate_summary(
    raw: String,
    covered_through_sequence: u32,
    max_summary_chars: usize,
) -> Result<ValidatedSummary, SummaryValidationError> {
    let content = raw.trim().to_string();
    if content.is_empty() {
        return Err(SummaryValidationError::Empty);
    }
    if content.chars().count() > max_summary_chars {
        return Err(SummaryValidationError::TooLarge {
            limit: max_summary_chars,
        });
    }
    let persisted = serde_json::to_value(TextCompactionSummary {
        version: 2,
        format: "text",
        content: &content,
        covered_through_sequence,
    })
    .map_err(SummaryValidationError::Serialization)?;
    Ok(ValidatedSummary { persisted })
}

fn source_hash(messages: &[NormalizedModelMessage]) -> Result<String, serde_json::Error> {
    serde_json::to_vec(messages).map(|bytes| hex::encode(Sha256::digest(bytes)))
}

fn bounded_failure_message(value: String) -> String {
    if value.chars().count() <= MAX_FAILURE_MESSAGE_CHARS {
        return value;
    }
    let retained = MAX_FAILURE_MESSAGE_CHARS.saturating_sub(3);
    let mut truncated = value.chars().take(retained).collect::<String>();
    truncated.push_str("...");
    truncated
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        path::{Path, PathBuf},
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
    };

    use async_trait::async_trait;
    use codez_core::{
        AppError, AtomicCreateOutcome, AtomicPersistence, PortFuture, SessionId,
        context::{
            ContextScopeId, LedgerAppendRequest, LedgerEvent, LedgerEventType,
            NormalizedModelMessage, UserMessagePayload,
        },
    };
    use tokio::sync::{Barrier, Mutex};

    use super::{
        CompactionError, CompactionFailureCode, CompactionRequest, CompactionService,
        CompactionSnapshotStatus, CompactionStatus, CompactionSummarizer,
        CompactionSummarizerError, CompactionSummaryInput,
    };
    use crate::context::{budget::ModelContextCapabilities, ledger::ModelLedgerStore};

    struct MemoryPersistence {
        entries: Mutex<BTreeMap<PathBuf, Vec<u8>>>,
        append_calls: AtomicUsize,
        fail_append_on_call: AtomicUsize,
        fail_next_replace: AtomicBool,
    }

    impl Default for MemoryPersistence {
        fn default() -> Self {
            Self {
                entries: Mutex::new(BTreeMap::new()),
                append_calls: AtomicUsize::new(0),
                fail_append_on_call: AtomicUsize::new(usize::MAX),
                fail_next_replace: AtomicBool::new(false),
            }
        }
    }

    impl MemoryPersistence {
        fn fail_append_on_call(&self, call: usize) {
            self.append_calls.store(0, Ordering::Release);
            self.fail_append_on_call.store(call, Ordering::Release);
        }

        fn fail_next_replace(&self) {
            self.fail_next_replace.store(true, Ordering::Release);
        }

        async fn bytes(&self, path: &Path) -> Vec<u8> {
            self.entries
                .lock()
                .await
                .get(path)
                .cloned()
                .unwrap_or_default()
        }
    }

    impl AtomicPersistence for MemoryPersistence {
        fn read<'a>(&'a self, path: &'a Path) -> PortFuture<'a, Option<Vec<u8>>> {
            Box::pin(async move { Ok(self.entries.lock().await.get(path).cloned()) })
        }

        fn replace<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
            Box::pin(async move {
                if self.fail_next_replace.swap(false, Ordering::AcqRel) {
                    return Err(AppError::storage(
                        "The test snapshot write failed",
                        "configured replace failure",
                        true,
                    ));
                }
                self.entries
                    .lock()
                    .await
                    .insert(path.to_path_buf(), bytes.to_vec());
                Ok(())
            })
        }

        fn create_no_clobber<'a>(
            &'a self,
            path: &'a Path,
            bytes: &'a [u8],
        ) -> PortFuture<'a, AtomicCreateOutcome> {
            Box::pin(async move {
                let mut entries = self.entries.lock().await;
                match entries.get(path) {
                    Some(existing) if existing == bytes => Ok(AtomicCreateOutcome::Reused),
                    Some(_) => Err(AppError::conflict(
                        "The test no-clobber target contains different bytes",
                    )),
                    None => {
                        entries.insert(path.to_path_buf(), bytes.to_vec());
                        Ok(AtomicCreateOutcome::Created)
                    }
                }
            })
        }

        fn append<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
            Box::pin(async move {
                let call = self.append_calls.fetch_add(1, Ordering::AcqRel) + 1;
                if self.fail_append_on_call.load(Ordering::Acquire) == call {
                    return Err(AppError::storage(
                        "The test ledger append failed",
                        "configured append failure",
                        true,
                    ));
                }
                self.entries
                    .lock()
                    .await
                    .entry(path.to_path_buf())
                    .or_default()
                    .extend_from_slice(bytes);
                Ok(())
            })
        }

        fn remove<'a>(&'a self, path: &'a Path) -> PortFuture<'a, bool> {
            Box::pin(async move { Ok(self.entries.lock().await.remove(path).is_some()) })
        }
    }

    struct Fixture {
        directory: tempfile::TempDir,
        runtime_root: PathBuf,
        store: ModelLedgerStore,
        persistence: Arc<MemoryPersistence>,
    }

    fn fixture() -> Fixture {
        let directory = tempfile::tempdir().expect("temporary fixture directory must be available");
        let runtime_root = directory.path().join("runtime");
        let persistence = Arc::new(MemoryPersistence::default());
        let store = ModelLedgerStore::new(&runtime_root, persistence.clone());
        Fixture {
            directory,
            runtime_root,
            store,
            persistence,
        }
    }

    #[derive(Clone)]
    struct StaticSummarizer {
        result: Result<String, CompactionSummarizerError>,
        calls: Arc<AtomicUsize>,
    }

    impl StaticSummarizer {
        fn success(summary: &str) -> Self {
            Self {
                result: Ok(summary.to_string()),
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn failure(message: &str, retryable: bool) -> Self {
            Self {
                result: Err(CompactionSummarizerError::generation(message, retryable)),
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }
    }

    #[async_trait]
    impl CompactionSummarizer for StaticSummarizer {
        async fn summarize(
            &self,
            _input: CompactionSummaryInput,
        ) -> Result<String, CompactionSummarizerError> {
            self.calls.fetch_add(1, Ordering::AcqRel);
            self.result.clone()
        }
    }

    struct BarrierSummarizer {
        barrier: Arc<Barrier>,
        summary: String,
    }

    #[async_trait]
    impl CompactionSummarizer for BarrierSummarizer {
        async fn summarize(
            &self,
            _input: CompactionSummaryInput,
        ) -> Result<String, CompactionSummarizerError> {
            self.barrier.wait().await;
            Ok(self.summary.clone())
        }
    }

    fn request(scope: ContextScopeId) -> CompactionRequest {
        CompactionRequest {
            session_id: "session-1".to_string(),
            context_scope_id: scope,
            trigger: "manual".to_string(),
            capabilities: ModelContextCapabilities {
                context_window_tokens: Some(2_000),
                max_output_tokens: Some(256),
                max_input_tokens: None,
                reasoning_counts_against_context: Some(false),
            },
            system_prompt: "You are a coding agent.".to_string(),
            manual_instructions: None,
            workspace_root: None,
            reasoning_budget_tokens: None,
            provider_id: Some("test-provider".to_string()),
            model: Some("test-model".to_string()),
            required_message_id: None,
        }
    }

    async fn seed_history(store: &ModelLedgerStore) {
        for index in 0..4 {
            let payload = UserMessagePayload {
                message: NormalizedModelMessage {
                    id: format!("message-{index}"),
                    client_message_id: None,
                    turn_id: "turn-1".to_string(),
                    role: "user".to_string(),
                    content: format!("message {index}: {}", "x".repeat(1_200)),
                    tool_calls: None,
                    tool_call_id: None,
                    name: None,
                    status: "complete".to_string(),
                    created_at: "2026-07-16T00:00:00.000Z".to_string(),
                    source_sequence: None,
                    attachments: None,
                    file_references: None,
                },
                provider_id: Some("test-provider".to_string()),
                model: Some("test-model".to_string()),
                command_metadata: None,
            };
            store
                .append_event(LedgerAppendRequest {
                    event_id: format!("message-event-{index}"),
                    session_id: "session-1".to_string(),
                    context_scope_id: ContextScopeId::Main,
                    turn_id: Some("turn-1".to_string()),
                    created_at: "2026-07-16T00:00:00.000Z".to_string(),
                    r#type: LedgerEventType::UserMessage,
                    payload: serde_json::to_value(payload).expect("fixture payload must serialize"),
                })
                .await
                .expect("fixture history must persist");
        }
    }

    async fn event_types(
        persistence: &MemoryPersistence,
        store: &ModelLedgerStore,
    ) -> Vec<LedgerEventType> {
        let session_id = SessionId::parse("session-1").expect("fixture id must be valid");
        persistence
            .bytes(&store.ledger_path(&session_id))
            .await
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| {
                serde_json::from_slice::<LedgerEvent>(line)
                    .expect("fixture ledger line must deserialize")
                    .r#type
            })
            .collect()
    }

    #[tokio::test]
    async fn compact_persists_completed_payload_and_replays_after_restart() {
        let fixture = fixture();
        seed_history(&fixture.store).await;
        let summarizer = StaticSummarizer::success("Continue with the pending validation.");
        let service = CompactionService::new(fixture.store.clone(), Arc::new(summarizer.clone()));

        let result = service
            .compact(request(ContextScopeId::Main))
            .await
            .expect("compaction must succeed");
        let restarted = ModelLedgerStore::new(&fixture.runtime_root, fixture.persistence.clone());
        let session_id = SessionId::parse("session-1").expect("fixture id must be valid");
        let snapshot = restarted
            .get_snapshot(&session_id)
            .await
            .expect("replay must succeed")
            .expect("snapshot must exist");
        let scope = snapshot.scopes.get("main").expect("main scope must replay");
        let event_types = event_types(&fixture.persistence, &fixture.store).await;

        assert_eq!(result.status, CompactionStatus::Completed);
        assert_eq!(
            result.snapshot_status,
            Some(CompactionSnapshotStatus::Committed)
        );
        assert_eq!(summarizer.calls.load(Ordering::Acquire), 1);
        assert!(event_types.contains(&LedgerEventType::CompactionStarted));
        assert!(event_types.contains(&LedgerEventType::CompactionCompleted));
        assert_eq!(scope.active_messages.len(), 1);
        assert_eq!(
            scope
                .latest_compaction
                .as_ref()
                .and_then(|summary| summary.get("content"))
                .and_then(serde_json::Value::as_str),
            Some("Continue with the pending validation.")
        );
        assert!(fixture.directory.path().exists());
    }

    #[tokio::test]
    async fn compact_records_failed_event_when_summarizer_fails() {
        let fixture = fixture();
        seed_history(&fixture.store).await;
        let service = CompactionService::new(
            fixture.store.clone(),
            Arc::new(StaticSummarizer::failure("Provider unavailable", true)),
        );

        let result = service
            .compact(request(ContextScopeId::Main))
            .await
            .expect("durable failure must be returned");
        let event_types = event_types(&fixture.persistence, &fixture.store).await;
        let session_id = SessionId::parse("session-1").expect("fixture id must be valid");
        let snapshot = fixture
            .store
            .get_snapshot(&session_id)
            .await
            .expect("failed compaction must remain replayable")
            .expect("history must remain available");

        assert_eq!(result.status, CompactionStatus::Failed);
        assert_eq!(
            result.error_code,
            Some(CompactionFailureCode::SummaryFailed)
        );
        assert!(event_types.contains(&LedgerEventType::CompactionStarted));
        assert!(event_types.contains(&LedgerEventType::CompactionFailed));
        assert!(!event_types.contains(&LedgerEventType::CompactionCompleted));
        assert_eq!(
            snapshot
                .scopes
                .get("main")
                .expect("main scope must remain available")
                .active_messages
                .len(),
            4
        );
    }

    #[tokio::test]
    async fn compact_rejects_empty_summary_without_completed_event() {
        let fixture = fixture();
        seed_history(&fixture.store).await;
        let service = CompactionService::new(
            fixture.store.clone(),
            Arc::new(StaticSummarizer::success("   ")),
        );

        let result = service
            .compact(request(ContextScopeId::Main))
            .await
            .expect("invalid summary must become a durable failure");
        let event_types = event_types(&fixture.persistence, &fixture.store).await;

        assert_eq!(result.status, CompactionStatus::Failed);
        assert_eq!(
            result.error_code,
            Some(CompactionFailureCode::SchemaInvalid)
        );
        assert!(event_types.contains(&LedgerEventType::CompactionFailed));
        assert!(!event_types.contains(&LedgerEventType::CompactionCompleted));
    }

    #[tokio::test]
    async fn compact_rejects_summary_above_the_configured_limit() {
        let fixture = fixture();
        seed_history(&fixture.store).await;
        let service = CompactionService::new(
            fixture.store.clone(),
            Arc::new(StaticSummarizer::success("summary longer than limit")),
        )
        .with_max_summary_chars(8);

        let result = service
            .compact(request(ContextScopeId::Main))
            .await
            .expect("oversized summary must become a durable failure");

        assert_eq!(result.status, CompactionStatus::Failed);
        assert_eq!(
            result.error_code,
            Some(CompactionFailureCode::SchemaInvalid)
        );
    }

    #[tokio::test]
    async fn compact_marks_snapshot_deferred_when_snapshot_write_fails() {
        let fixture = fixture();
        seed_history(&fixture.store).await;
        fixture.persistence.fail_next_replace();
        let service = CompactionService::new(
            fixture.store.clone(),
            Arc::new(StaticSummarizer::success(
                "Continue after a deferred snapshot.",
            )),
        );

        let result = service
            .compact(request(ContextScopeId::Main))
            .await
            .expect("completed ledger state must remain usable");

        assert_eq!(result.status, CompactionStatus::Completed);
        assert_eq!(
            result.snapshot_status,
            Some(CompactionSnapshotStatus::Deferred)
        );
        assert!(result.message.is_some());
    }

    #[tokio::test]
    async fn compact_records_failure_when_completed_append_fails() {
        let fixture = fixture();
        seed_history(&fixture.store).await;
        fixture.persistence.fail_append_on_call(2);
        let service = CompactionService::new(
            fixture.store.clone(),
            Arc::new(StaticSummarizer::success("Continue after write recovery.")),
        );

        let result = service
            .compact(request(ContextScopeId::Main))
            .await
            .expect("a recoverable append failure must be recorded");
        let event_types = event_types(&fixture.persistence, &fixture.store).await;

        assert_eq!(result.status, CompactionStatus::Failed);
        assert_eq!(
            result.error_code,
            Some(CompactionFailureCode::PersistenceFailed)
        );
        assert!(event_types.contains(&LedgerEventType::CompactionFailed));
        assert!(!event_types.contains(&LedgerEventType::CompactionCompleted));
    }

    #[tokio::test]
    async fn concurrent_compactions_preserve_one_completion_and_one_stale_failure() {
        let fixture = fixture();
        seed_history(&fixture.store).await;
        let service = Arc::new(CompactionService::new(
            fixture.store.clone(),
            Arc::new(BarrierSummarizer {
                barrier: Arc::new(Barrier::new(2)),
                summary: "Continue from the durable summary.".to_string(),
            }),
        ));
        let first = service.compact(request(ContextScopeId::Main));
        let second = service.compact(request(ContextScopeId::Main));
        let (first, second) = tokio::join!(first, second);
        let results = [
            first.expect("first compaction must resolve"),
            second.expect("second compaction must resolve"),
        ];

        assert_eq!(
            results
                .iter()
                .filter(|result| result.status == CompactionStatus::Completed)
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| result.error_code == Some(CompactionFailureCode::StaleHistory))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn compact_records_insufficient_history_for_an_unknown_scope() {
        let fixture = fixture();
        seed_history(&fixture.store).await;
        let summarizer = StaticSummarizer::success("This summary must not be generated.");
        let service = CompactionService::new(fixture.store.clone(), Arc::new(summarizer.clone()));

        let result = service
            .compact(request(ContextScopeId::Subagent("missing".to_string())))
            .await
            .expect("unknown scope must produce a durable failure");

        assert_eq!(result.status, CompactionStatus::Failed);
        assert_eq!(
            result.error_code,
            Some(CompactionFailureCode::InsufficientHistory)
        );
        assert_eq!(summarizer.calls.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn compact_rejects_an_empty_session_identifier_before_writing() {
        let fixture = fixture();
        let service = CompactionService::new(
            fixture.store,
            Arc::new(StaticSummarizer::success("unreachable")),
        );
        let mut request = request(ContextScopeId::Main);
        request.session_id = " ".to_string();

        let error = service
            .compact(request)
            .await
            .expect_err("empty session id must be rejected");

        assert!(matches!(error, CompactionError::EmptySessionId));
    }

    #[tokio::test]
    async fn compact_rejects_an_illegal_session_identifier_before_writing() {
        let fixture = fixture();
        let service = CompactionService::new(
            fixture.store.clone(),
            Arc::new(StaticSummarizer::success("unreachable")),
        );
        let mut request = request(ContextScopeId::Main);
        request.session_id = "../session".to_string();

        let error = service
            .compact(request)
            .await
            .expect_err("illegal session id must be rejected");

        assert!(matches!(error, CompactionError::InvalidSessionId(_)));
        assert!(!fixture.runtime_root.exists());
    }
}
