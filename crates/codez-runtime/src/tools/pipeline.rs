use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use async_trait::async_trait;
use codez_core::CancellationToken;

use crate::tools::authorization::{
    AuthorizationBinding, AuthorizationReceipt, AuthorizationReceiptError,
    AuthorizationReceiptIssuer,
};
use crate::tools::exposure::{ToolCatalogSnapshot, ToolExposurePlan};
use crate::tools::journal::{ToolExecutionJournal, ToolJournalEvent, ToolJournalIdentity};
use crate::tools::processor::ToolResultProcessor;
use crate::tools::registry::{ToolContext, ToolFileServices};
use crate::tools::scheduler::ToolScheduler;
use crate::tools::types::{
    AgentRole, NormalizedToolCall, PreparedToolCall, ToolAvailabilityContext, ToolExecutionError,
    ToolExecutionResult, ToolPipelineResult, ToolPlanningContext,
};
use crate::tools::validation::{ToolInputValidationResult, ToolInputValidator};

const DEFAULT_RECEIPT_TTL: Duration = Duration::from_secs(30);

/// Permission outcome returned after the complete effect plan has been evaluated.
#[derive(Debug, Clone)]
pub struct ToolAuthorizationDecision {
    pub authorized: bool,
    pub request_id: Option<String>,
    pub permission_rule_id: Option<String>,
    pub permission_mode: Option<String>,
    pub error: Option<ToolExecutionError>,
    pub receipt_ttl: Duration,
}

impl ToolAuthorizationDecision {
    #[must_use]
    pub fn allow(request_id: impl Into<String>) -> Self {
        Self {
            authorized: true,
            request_id: Some(request_id.into()),
            permission_rule_id: None,
            permission_mode: None,
            error: None,
            receipt_ttl: DEFAULT_RECEIPT_TTL,
        }
    }

    #[must_use]
    pub fn deny(error: ToolExecutionError) -> Self {
        Self {
            authorized: false,
            request_id: None,
            permission_rule_id: None,
            permission_mode: None,
            error: Some(error),
            receipt_ttl: Duration::ZERO,
        }
    }
}

/// Per-batch environment. Authorization remains mandatory and receives classified effects.
#[async_trait]
pub trait ToolExecutionPipelineContext: Send + Sync {
    fn catalog(&self) -> &ToolCatalogSnapshot;
    fn exposure(&self) -> Option<&ToolExposurePlan>;
    fn workspace_root(&self) -> &Path;
    fn session_id(&self) -> Option<&str>;
    fn context_scope_id(&self) -> Cow<'_, str> {
        Cow::Borrowed(codez_core::context::MAIN_CONTEXT_SCOPE)
    }
    fn transaction_id(&self) -> Option<&str> {
        None
    }
    fn file_services(&self) -> Option<ToolFileServices> {
        None
    }
    fn agent_role(&self) -> &AgentRole;
    fn journal_identity(&self) -> Option<ToolJournalIdentity>;
    fn cancellation_token(&self, call: &NormalizedToolCall) -> CancellationToken;

    async fn authorize(
        &self,
        prepared: &PreparedToolCall,
        binding: &AuthorizationBinding,
    ) -> ToolAuthorizationDecision;
}

struct AuthorizedCall {
    prepared: PreparedToolCall,
    receipt: AuthorizationReceipt,
    binding: AuthorizationBinding,
}

struct WaveExecutionContext {
    identity: Option<ToolJournalIdentity>,
    index: usize,
    started: Instant,
}

pub struct ToolExecutionPipeline {
    validator: Arc<ToolInputValidator>,
    scheduler: Arc<ToolScheduler>,
    processor: Arc<ToolResultProcessor>,
    journal: Arc<ToolExecutionJournal>,
    receipt_issuer: AuthorizationReceiptIssuer,
}

impl ToolExecutionPipeline {
    #[must_use]
    pub fn new(
        validator: Arc<ToolInputValidator>,
        scheduler: Arc<ToolScheduler>,
        processor: Arc<ToolResultProcessor>,
        journal: Arc<ToolExecutionJournal>,
    ) -> Self {
        Self {
            validator,
            scheduler,
            processor,
            journal,
            receipt_issuer: AuthorizationReceiptIssuer::new(),
        }
    }

    /// Executes one normalized batch in the only allowed lifecycle order:
    /// validate, classify, authorize, schedule, execute, process, then journal.
    pub async fn execute_batch(
        &self,
        calls: Vec<NormalizedToolCall>,
        context: &dyn ToolExecutionPipelineContext,
    ) -> Vec<ToolPipelineResult> {
        let batch_started = Instant::now();
        let identity = context.journal_identity();
        let workspace_root = match tokio::fs::canonicalize(context.workspace_root()).await {
            Ok(root) if root.is_dir() => root,
            Ok(_) => {
                return self
                    .finish_without_execution(
                        calls,
                        context.workspace_root(),
                        context.session_id(),
                        identity,
                        pipeline_error(
                            "TOOL_WORKSPACE_INVALID",
                            "Tool execution requires a workspace directory.",
                            false,
                        ),
                    )
                    .await;
            }
            Err(error) => {
                tracing::warn!(error = %error, "tool workspace canonicalization failed");
                return self
                    .finish_without_execution(
                        calls,
                        context.workspace_root(),
                        context.session_id(),
                        identity,
                        pipeline_error(
                            "TOOL_WORKSPACE_INVALID",
                            "Tool execution requires a valid workspace directory.",
                            false,
                        ),
                    )
                    .await;
            }
        };
        let workspace_key = workspace_root.to_string_lossy().to_string();
        let catalog = context.catalog();
        let descriptors: Vec<_> = catalog
            .descriptors
            .iter()
            .map(|descriptor| descriptor.as_ref())
            .collect();
        self.validator.compile(&catalog.fingerprint, &descriptors);
        let mut catalog_identity = identity.clone().unwrap_or_default();
        catalog_identity.catalog_snapshot_id = Some(catalog.id.clone());
        catalog_identity.schema_fingerprint = Some(catalog.fingerprint.clone());
        self.record(
            Some(catalog_identity),
            ToolJournalEvent {
                event: "catalog.snapshot.created".to_string(),
                ..ToolJournalEvent::default()
            },
        )
        .await;

        let exposed_names = context.exposure().map(|exposure| {
            exposure
                .eager_tools
                .iter()
                .map(|descriptor| descriptor.name().to_string())
                .collect::<HashSet<_>>()
        });
        let planning_context = ToolPlanningContext {
            workspace_root: workspace_root.clone(),
            session_id: context.session_id().map(str::to_string),
            agent_role: context.agent_role().clone(),
        };
        let availability_context = ToolAvailabilityContext {
            platform: std::env::consts::OS.to_string(),
            agent_role: context.agent_role().clone(),
            workspace_root: Some(workspace_root.clone()),
        };
        let mut immediate = HashMap::new();
        let mut prepared = Vec::new();

        for call in &calls {
            self.record(
                identity.clone(),
                ToolJournalEvent {
                    event: "tool.call.received".to_string(),
                    call_id: Some(call.call_id.clone()),
                    tool_name: Some(call.name.clone()),
                    input_bytes: Some(call.raw_arguments.len()),
                    ..ToolJournalEvent::default()
                },
            )
            .await;
            let canonical_name = catalog.canonical_name(&call.name).to_string();
            let Some(handler) = catalog.handler(&canonical_name) else {
                let result = pipeline_result(
                    call.clone(),
                    canonical_name,
                    ToolExecutionResult::Error {
                        error: pipeline_error(
                            "TOOL_UNAVAILABLE",
                            &format!(
                                "Tool '{}' is not available in this Rust runtime.",
                                call.name
                            ),
                            false,
                        ),
                        model_content: None,
                        ui_content: None,
                        effects: None,
                    },
                    None,
                );
                self.record_terminal(identity.clone(), &result, None).await;
                immediate.insert(call.position, result);
                continue;
            };
            if exposed_names
                .as_ref()
                .is_some_and(|names| !names.contains(&canonical_name))
            {
                let result = pipeline_result(
                    call.clone(),
                    canonical_name,
                    ToolExecutionResult::Error {
                        error: pipeline_error(
                            "TOOL_NOT_EXPOSED",
                            "The tool was not exposed for this turn.",
                            true,
                        ),
                        model_content: None,
                        ui_content: None,
                        effects: None,
                    },
                    None,
                );
                self.record_terminal(identity.clone(), &result, None).await;
                immediate.insert(call.position, result);
                continue;
            }
            if !handler.descriptor().is_enabled(&availability_context) {
                let result = pipeline_result(
                    call.clone(),
                    canonical_name,
                    ToolExecutionResult::Error {
                        error: pipeline_error(
                            "TOOL_UNAVAILABLE",
                            "The tool is disabled in the current environment.",
                            false,
                        ),
                        model_content: None,
                        ui_content: None,
                        effects: None,
                    },
                    None,
                );
                self.record_terminal(identity.clone(), &result, None).await;
                immediate.insert(call.position, result);
                continue;
            }

            let validation = self.validator.validate(
                &catalog.fingerprint,
                handler.descriptor(),
                &call.raw_arguments,
            );
            let input = match validation {
                ToolInputValidationResult::Success { input } => input,
                ToolInputValidationResult::Failure { error } => {
                    let result = pipeline_result(
                        call.clone(),
                        canonical_name,
                        ToolExecutionResult::Error {
                            error: ToolExecutionError {
                                code: error.code,
                                message: error.message,
                                recoverable: true,
                                suggestion: None,
                                retry_after_ms: None,
                                details: error
                                    .issues
                                    .map(|issues| serde_json::json!({ "issues": issues })),
                            },
                            model_content: None,
                            ui_content: None,
                            effects: None,
                        },
                        None,
                    );
                    self.record_terminal(identity.clone(), &result, None).await;
                    immediate.insert(call.position, result);
                    continue;
                }
            };
            let input = handler.normalize_input(input);
            let (effects, resource_keys) = tokio::join!(
                handler.plan_effects(&input, &planning_context),
                handler.resource_keys(&input, &planning_context)
            );
            prepared.push(PreparedToolCall {
                call: NormalizedToolCall {
                    name: canonical_name.clone(),
                    ..call.clone()
                },
                canonical_name,
                handler: Arc::clone(handler),
                input,
                effects,
                resource_keys,
            });
        }

        let mut authorized = Vec::new();
        for item in prepared {
            let binding = AuthorizationBinding::for_call(
                &item,
                &workspace_key,
                context.session_id(),
                context.agent_role(),
            );
            let decision = context.authorize(&item, &binding).await;
            self.record(
                identity.clone(),
                ToolJournalEvent {
                    event: "tool.call.permission_decided".to_string(),
                    call_id: Some(item.call.call_id.clone()),
                    tool_name: Some(item.canonical_name.clone()),
                    decision: Some(if decision.authorized { "allow" } else { "deny" }.to_string()),
                    status: Some(
                        if decision.authorized {
                            "queued"
                        } else {
                            "denied"
                        }
                        .to_string(),
                    ),
                    permission_rule_id: decision.permission_rule_id.clone(),
                    permission_mode: decision.permission_mode.clone(),
                    ..ToolJournalEvent::default()
                },
            )
            .await;
            if !decision.authorized {
                let result = pipeline_result(
                    item.call.clone(),
                    item.canonical_name,
                    ToolExecutionResult::Denied {
                        error: decision.error.unwrap_or_else(|| {
                            pipeline_error(
                                "TOOL_DENIED",
                                "Tool execution was denied by permission policy.",
                                false,
                            )
                        }),
                        model_content: None,
                        ui_content: None,
                        effects: Some(item.effects.effects),
                    },
                    Some(item.handler.descriptor().behavior().max_result_chars as usize),
                );
                self.record_terminal(identity.clone(), &result, None).await;
                immediate.insert(item.call.position, result);
                continue;
            }
            let receipt =
                self.receipt_issuer
                    .issue(&binding, decision.receipt_ttl, SystemTime::now());
            authorized.push(AuthorizedCall {
                prepared: item,
                receipt,
                binding,
            });
        }

        let receipt_by_call: HashMap<_, _> = authorized
            .iter()
            .map(|authorized| {
                (
                    authorized.prepared.call.call_id.clone(),
                    (authorized.receipt.clone(), authorized.binding.clone()),
                )
            })
            .collect();
        let authorized_calls: Vec<_> = authorized
            .into_iter()
            .map(|authorized| authorized.prepared)
            .collect();
        let mut executed = HashMap::new();
        for wave in self.scheduler.plan(&authorized_calls) {
            let wave_started = Instant::now();
            let futures = wave.calls.into_iter().map(|item| {
                let receipt = receipt_by_call.get(&item.call.call_id).cloned();
                let workspace_root = workspace_root.clone();
                let identity = identity.clone();
                async move {
                    let wave_context = WaveExecutionContext {
                        identity,
                        index: wave.index,
                        started: wave_started,
                    };
                    self.execute_authorized(item, receipt, context, &workspace_root, wave_context)
                        .await
                }
            });
            for result in futures::future::join_all(futures).await {
                executed.insert(result.call.position, result);
            }
        }

        let ordered = calls
            .into_iter()
            .map(|call| {
                immediate
                    .remove(&call.position)
                    .or_else(|| executed.remove(&call.position))
                    .unwrap_or_else(|| {
                        pipeline_result(
                            call.clone(),
                            call.name,
                            ToolExecutionResult::Error {
                                error: pipeline_error(
                                    "TOOL_RESULT_MISSING",
                                    "Tool execution produced no terminal result.",
                                    false,
                                ),
                                model_content: None,
                                ui_content: None,
                                effects: None,
                            },
                            None,
                        )
                    })
            })
            .collect();
        let processed = self
            .processor
            .process_batch(ordered, &workspace_root, context.session_id())
            .await;
        self.record(
            identity,
            ToolJournalEvent {
                event: "tool.batch.completed".to_string(),
                status: Some(
                    if processed
                        .iter()
                        .all(|item| matches!(item.result, ToolExecutionResult::Success { .. }))
                    {
                        "success"
                    } else {
                        "partial"
                    }
                    .to_string(),
                ),
                execution_duration_ms: Some(duration_millis(batch_started.elapsed())),
                batch_size: Some(processed.len()),
                ..ToolJournalEvent::default()
            },
        )
        .await;
        processed
    }

    async fn execute_authorized(
        &self,
        item: PreparedToolCall,
        receipt_and_binding: Option<(AuthorizationReceipt, AuthorizationBinding)>,
        context: &dyn ToolExecutionPipelineContext,
        workspace_root: &Path,
        wave_context: WaveExecutionContext,
    ) -> ToolPipelineResult {
        let WaveExecutionContext {
            identity,
            index: wave_index,
            started: wave_started,
        } = wave_context;
        let Some((receipt, binding)) = receipt_and_binding else {
            return pipeline_result(
                item.call,
                item.canonical_name,
                ToolExecutionResult::Denied {
                    error: pipeline_error(
                        "TOOL_AUTHORIZATION_INVALID",
                        "Tool authorization receipt was missing.",
                        false,
                    ),
                    model_content: None,
                    ui_content: None,
                    effects: Some(item.effects.effects),
                },
                Some(item.handler.descriptor().behavior().max_result_chars as usize),
            );
        };
        let current_binding = AuthorizationBinding::for_call(
            &item,
            &workspace_root.to_string_lossy(),
            context.session_id(),
            context.agent_role(),
        );
        if let Err(error) =
            self.receipt_issuer
                .validate(&receipt, &current_binding, SystemTime::now())
        {
            let code = match error {
                AuthorizationReceiptError::Expired => "TOOL_AUTHORIZATION_EXPIRED",
                AuthorizationReceiptError::BindingMismatch
                | AuthorizationReceiptError::InvalidSignature => "TOOL_AUTHORIZATION_INVALID",
            };
            let result = pipeline_result(
                item.call,
                item.canonical_name,
                ToolExecutionResult::Denied {
                    error: pipeline_error(code, &error.to_string(), false),
                    model_content: None,
                    ui_content: None,
                    effects: Some(item.effects.effects),
                },
                Some(item.handler.descriptor().behavior().max_result_chars as usize),
            );
            self.record_terminal(identity, &result, Some(wave_index))
                .await;
            return result;
        }
        if binding != current_binding {
            let result = pipeline_result(
                item.call,
                item.canonical_name,
                ToolExecutionResult::Denied {
                    error: pipeline_error(
                        "TOOL_AUTHORIZATION_INVALID",
                        "Tool authorization changed before execution.",
                        false,
                    ),
                    model_content: None,
                    ui_content: None,
                    effects: Some(item.effects.effects),
                },
                Some(item.handler.descriptor().behavior().max_result_chars as usize),
            );
            self.record_terminal(identity, &result, Some(wave_index))
                .await;
            return result;
        }

        let cancellation = context.cancellation_token(&item.call);
        if cancellation.is_cancelled() {
            let result = cancelled_result(&item, "Tool execution was cancelled before it started.");
            self.record_terminal(identity, &result, Some(wave_index))
                .await;
            return result;
        }
        self.record(
            identity.clone(),
            ToolJournalEvent {
                event: "tool.call.started".to_string(),
                call_id: Some(item.call.call_id.clone()),
                tool_name: Some(item.canonical_name.clone()),
                queue_duration_ms: Some(duration_millis(wave_started.elapsed())),
                wave: Some(wave_index),
                ..ToolJournalEvent::default()
            },
        )
        .await;
        let execution_started = Instant::now();
        let tool_context = ToolContext {
            execution_id: receipt.id().to_string(),
            call_id: item.call.call_id.clone(),
            turn_id: identity
                .as_ref()
                .and_then(|identity| identity.turn_id.clone()),
            session_id: context.session_id().map(str::to_string),
            context_scope_id: context.context_scope_id().into_owned(),
            transaction_id: context.transaction_id().map(str::to_string),
            workspace_root: workspace_root.to_path_buf(),
            cancellation: cancellation.clone(),
            authorized_effects: item.effects.clone(),
            file_services: context.file_services(),
            deferred_tools: context
                .exposure()
                .map(|exposure| exposure.deferred_tools.clone())
                .unwrap_or_default(),
        };
        let behavior = item.handler.descriptor().behavior();
        let execution = item.handler.execute(&item.input, &tool_context);
        let raw_result = if behavior.interrupt == crate::tools::types::ToolInterruptBehavior::Block
        {
            execution.await
        } else if let Some(timeout_ms) = behavior.timeout_ms {
            tokio::select! {
                () = cancellation.cancelled() => cancelled_execution("Tool execution was cancelled."),
                result = tokio::time::timeout(Duration::from_millis(u64::from(timeout_ms)), execution) => {
                    result.unwrap_or_else(|_| timeout_execution())
                }
            }
        } else {
            tokio::select! {
                () = cancellation.cancelled() => cancelled_execution("Tool execution was cancelled."),
                result = execution => result,
            }
        };
        let result = pipeline_result(
            item.call,
            item.canonical_name,
            attach_effects(raw_result, &item.effects.effects),
            Some(behavior.max_result_chars as usize),
        );
        self.record_terminal_with_duration(
            identity,
            &result,
            Some(wave_index),
            execution_started.elapsed(),
        )
        .await;
        result
    }

    async fn finish_without_execution(
        &self,
        calls: Vec<NormalizedToolCall>,
        workspace_root: &Path,
        session_id: Option<&str>,
        identity: Option<ToolJournalIdentity>,
        error: ToolExecutionError,
    ) -> Vec<ToolPipelineResult> {
        let results: Vec<_> = calls
            .into_iter()
            .map(|call| {
                pipeline_result(
                    call.clone(),
                    call.name,
                    ToolExecutionResult::Error {
                        error: error.clone(),
                        model_content: None,
                        ui_content: None,
                        effects: None,
                    },
                    None,
                )
            })
            .collect();
        for result in &results {
            self.record_terminal(identity.clone(), result, None).await;
        }
        self.processor
            .process_batch(results, workspace_root, session_id)
            .await
    }

    async fn record(&self, identity: Option<ToolJournalIdentity>, mut event: ToolJournalEvent) {
        event.identity = identity;
        if let Err(error) = self.journal.append(event).await {
            tracing::warn!(error = %error, "tool execution journal append failed");
        }
    }

    async fn record_terminal(
        &self,
        identity: Option<ToolJournalIdentity>,
        result: &ToolPipelineResult,
        wave: Option<usize>,
    ) {
        self.record_terminal_with_duration(identity, result, wave, Duration::ZERO)
            .await;
    }

    async fn record_terminal_with_duration(
        &self,
        identity: Option<ToolJournalIdentity>,
        result: &ToolPipelineResult,
        wave: Option<usize>,
        duration: Duration,
    ) {
        let (event, status, error_code, recoverable) = result_status(&result.result);
        self.record(
            identity,
            ToolJournalEvent {
                event: event.to_string(),
                call_id: Some(result.call.call_id.clone()),
                tool_name: Some(result.canonical_name.clone()),
                status: Some(status.to_string()),
                error_code,
                recoverable,
                execution_duration_ms: Some(duration_millis(duration)),
                wave,
                ..ToolJournalEvent::default()
            },
        )
        .await;
    }
}

fn pipeline_error(code: &str, message: &str, recoverable: bool) -> ToolExecutionError {
    ToolExecutionError {
        code: code.to_string(),
        message: message.to_string(),
        recoverable,
        suggestion: None,
        retry_after_ms: None,
        details: None,
    }
}

fn pipeline_result(
    call: NormalizedToolCall,
    canonical_name: String,
    result: ToolExecutionResult,
    max_result_chars: Option<usize>,
) -> ToolPipelineResult {
    ToolPipelineResult {
        call,
        canonical_name,
        result,
        max_result_chars,
    }
}

fn cancelled_result(item: &PreparedToolCall, message: &str) -> ToolPipelineResult {
    pipeline_result(
        item.call.clone(),
        item.canonical_name.clone(),
        cancelled_execution(message),
        Some(item.handler.descriptor().behavior().max_result_chars as usize),
    )
}

fn cancelled_execution(message: &str) -> ToolExecutionResult {
    ToolExecutionResult::Cancelled {
        error: pipeline_error("TOOL_CANCELLED", message, false),
        model_content: None,
        ui_content: None,
        effects: None,
    }
}

fn timeout_execution() -> ToolExecutionResult {
    ToolExecutionResult::Error {
        error: ToolExecutionError {
            code: "TOOL_TIMEOUT".to_string(),
            message: "Tool execution exceeded its timeout.".to_string(),
            recoverable: true,
            suggestion: None,
            retry_after_ms: None,
            details: None,
        },
        model_content: None,
        ui_content: None,
        effects: None,
    }
}

fn attach_effects(
    result: ToolExecutionResult,
    planned_effects: &[crate::tools::types::ToolEffect],
) -> ToolExecutionResult {
    let effects = Some(planned_effects.to_vec());
    match result {
        ToolExecutionResult::Success {
            data,
            model_content,
            ui_content,
            ..
        } => ToolExecutionResult::Success {
            data,
            model_content,
            ui_content,
            effects,
        },
        ToolExecutionResult::Error {
            error,
            model_content,
            ui_content,
            ..
        } => ToolExecutionResult::Error {
            error,
            model_content,
            ui_content,
            effects,
        },
        ToolExecutionResult::Denied {
            error,
            model_content,
            ui_content,
            ..
        } => ToolExecutionResult::Denied {
            error,
            model_content,
            ui_content,
            effects,
        },
        ToolExecutionResult::Cancelled {
            error,
            model_content,
            ui_content,
            ..
        } => ToolExecutionResult::Cancelled {
            error,
            model_content,
            ui_content,
            effects,
        },
    }
}

fn result_status(
    result: &ToolExecutionResult,
) -> (&'static str, &'static str, Option<String>, Option<bool>) {
    match result {
        ToolExecutionResult::Success { .. } => ("tool.call.completed", "success", None, None),
        ToolExecutionResult::Error { error, .. } => (
            "tool.call.failed",
            "error",
            Some(error.code.clone()),
            Some(error.recoverable),
        ),
        ToolExecutionResult::Denied { error, .. } => (
            "tool.call.denied",
            "denied",
            Some(error.code.clone()),
            Some(error.recoverable),
        ),
        ToolExecutionResult::Cancelled { error, .. } => (
            "tool.call.cancelled",
            "cancelled",
            Some(error.code.clone()),
            Some(error.recoverable),
        ),
    }
}

fn duration_millis(duration: Duration) -> u32 {
    u32::try_from(duration.as_millis()).unwrap_or(u32::MAX)
}
