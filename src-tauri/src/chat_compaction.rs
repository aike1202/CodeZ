use std::{sync::Arc, time::Duration};

use codez_contracts::chat::{ChatCompactionResponse, ChatCompactionResult};
use codez_core::{AppError, CancellationToken, SessionId, redact_sensitive_text};
use codez_core::{
    context::ContextScopeId,
    provider::{ChatMessage, ChatStreamEvent, Role},
};
use codez_providers::{
    chat::ChatProviderError,
    service::{ProviderService, ResolvedProviderChatConfig},
};
use codez_runtime::context::{
    budget::ModelContextCapabilities,
    compaction::{
        CompactionRequest, CompactionResult, CompactionService, CompactionSnapshotStatus,
        CompactionStatus, CompactionSummarizer, CompactionSummarizerError, CompactionSummaryInput,
    },
    ledger::ModelLedgerStore,
};
use codez_runtime::session_maintenance::SessionExclusiveActivityLease;
use futures_util::StreamExt;

use crate::chat_runtime::open_provider_stream;

const COMPACTION_PROVIDER_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_MANUAL_INSTRUCTIONS_BYTES: usize = 16 * 1024;
const MAX_COMPACTION_SOURCE_BYTES: usize = 8 * 1024 * 1024;
const COMPACTION_SYSTEM_PROMPT: &str = "Summarize the supplied prior conversation for a future coding assistant. Preserve user intent, completed work, unresolved decisions, constraints, concrete file paths, commands and validation evidence. Do not invent facts. Be concise but retain details necessary to resume safely.";

pub(crate) struct AutoCompactionRequest<'a> {
    pub(crate) session_id: &'a SessionId,
    pub(crate) trigger: &'static str,
    pub(crate) capabilities: ModelContextCapabilities,
    pub(crate) reasoning_budget_tokens: Option<u32>,
    pub(crate) provider_id: &'a str,
    pub(crate) model: &'a str,
    pub(crate) required_message_id: &'a str,
}

/// Runs an explicit user-requested compaction using the session's most recently used Provider.
///
/// The durable compaction service owns ledger state transitions. This desktop boundary only
/// resolves the trusted Provider configuration and supplies an isolated, tool-free summarizer.
pub(crate) async fn compact_chat_session(
    providers: Arc<ProviderService>,
    ledger: Arc<ModelLedgerStore>,
    application_cancellation: CancellationToken,
    exclusive_activity: SessionExclusiveActivityLease,
    manual_instructions: Option<String>,
) -> Result<ChatCompactionResponse, AppError> {
    validate_manual_instructions(manual_instructions.as_deref())?;
    let session_id = exclusive_activity.session_id();
    let resolved = resolve_compaction_provider(&providers, &ledger, session_id).await?;
    let capabilities = ModelContextCapabilities {
        context_window_tokens: Some(resolved.model.max_context_tokens),
        max_output_tokens: resolved.model.max_output_tokens,
        max_input_tokens: resolved.model.max_input_tokens,
        reasoning_counts_against_context: resolved.model.reasoning_counts_against_context,
    };
    let request = CompactionRequest {
        session_id: session_id.as_str().to_string(),
        context_scope_id: ContextScopeId::Main,
        trigger: "manual".to_string(),
        capabilities,
        system_prompt: COMPACTION_SYSTEM_PROMPT.to_string(),
        manual_instructions,
        workspace_root: None,
        reasoning_budget_tokens: resolved.thinking.budget_tokens,
        provider_id: Some(resolved.provider_id),
        model: Some(resolved.model.id),
        required_message_id: None,
    };
    let result = run_compaction(providers, ledger, application_cancellation, request).await?;
    Ok(compaction_response(result))
}

/// Runs threshold or Provider-overflow compaction as part of an already-active chat turn.
///
/// The caller's session activity lease continues to block deletion while the ledger service uses
/// history-version compare-and-append to reject concurrent context mutations.
pub(crate) async fn compact_active_chat_context(
    providers: Arc<ProviderService>,
    ledger: Arc<ModelLedgerStore>,
    cancellation: CancellationToken,
    request: AutoCompactionRequest<'_>,
) -> Result<CompactionResult, AppError> {
    run_compaction(
        providers,
        ledger,
        cancellation,
        CompactionRequest {
            session_id: request.session_id.as_str().to_string(),
            context_scope_id: ContextScopeId::Main,
            trigger: request.trigger.to_string(),
            capabilities: request.capabilities,
            system_prompt: COMPACTION_SYSTEM_PROMPT.to_string(),
            manual_instructions: None,
            workspace_root: None,
            reasoning_budget_tokens: request.reasoning_budget_tokens,
            provider_id: Some(request.provider_id.to_string()),
            model: Some(request.model.to_string()),
            required_message_id: Some(request.required_message_id.to_string()),
        },
    )
    .await
}

async fn run_compaction(
    providers: Arc<ProviderService>,
    ledger: Arc<ModelLedgerStore>,
    cancellation: CancellationToken,
    request: CompactionRequest,
) -> Result<CompactionResult, AppError> {
    let summarizer = Arc::new(ProviderCompactionSummarizer {
        providers,
        cancellation,
    });
    CompactionService::new(ledger.as_ref().clone(), summarizer)
        .compact(request)
        .await
        .map_err(|error| {
            AppError::storage(
                "Chat compaction could not persist its session state",
                error.to_string(),
                true,
            )
        })
}

struct ProviderCompactionSummarizer {
    providers: Arc<ProviderService>,
    cancellation: CancellationToken,
}

#[async_trait::async_trait]
impl CompactionSummarizer for ProviderCompactionSummarizer {
    async fn summarize(
        &self,
        input: CompactionSummaryInput,
    ) -> Result<String, CompactionSummarizerError> {
        let provider_id = input.provider_id.as_deref();
        let model = input.model.as_deref();
        let resolved = self
            .providers
            .resolve_chat_config(provider_id, model)
            .await
            .map_err(|error| {
                CompactionSummarizerError::generation(error.public_message(), false)
            })?;
        let prompt = compaction_prompt(&input)?;
        let messages = vec![
            ChatMessage {
                role: Role::System,
                content: Some(COMPACTION_SYSTEM_PROMPT.to_string()),
                tool_calls: None,
                tool_call_id: None,
                name: None,
                images: Vec::new(),
            },
            ChatMessage {
                role: Role::User,
                content: Some(prompt),
                tool_calls: None,
                tool_call_id: None,
                name: None,
                images: Vec::new(),
            },
        ];
        summarize_with_provider(resolved, messages, self.cancellation.child_token()).await
    }
}

async fn resolve_compaction_provider(
    providers: &ProviderService,
    ledger: &ModelLedgerStore,
    session_id: &SessionId,
) -> Result<ResolvedProviderChatConfig, AppError> {
    let loaded = ledger.load(session_id).await.map_err(|error| {
        AppError::storage(
            "Chat compaction could not load the session history",
            error.to_string(),
            true,
        )
    })?;
    let (provider_id, model) = loaded
        .as_ref()
        .and_then(|runtime| runtime.snapshot.scopes.get("main"))
        .map_or((None, None), |scope| {
            (
                scope.last_provider_id.as_deref(),
                scope.last_model.as_deref(),
            )
        });
    providers.resolve_chat_config(provider_id, model).await
}

async fn summarize_with_provider(
    resolved: ResolvedProviderChatConfig,
    messages: Vec<ChatMessage>,
    cancellation: CancellationToken,
) -> Result<String, CompactionSummarizerError> {
    let operation = async {
        let mut stream = open_provider_stream(resolved, messages, None, cancellation.clone())
            .await
            .map_err(provider_summary_error)?;
        let mut content = String::new();
        loop {
            tokio::select! {
                () = cancellation.cancelled() => {
                    return Err(CompactionSummarizerError::generation(
                        "The compaction request was cancelled",
                        true,
                    ));
                }
                event = stream.next() => {
                    match event {
                        Some(Ok(ChatStreamEvent::Chunk { delta, tool_calls, .. })) => {
                            if tool_calls.is_some_and(|calls| !calls.is_empty()) {
                                return Err(CompactionSummarizerError::generation(
                                    "The compaction model attempted to call a tool",
                                    false,
                                ));
                            }
                            content.push_str(&delta);
                        }
                        Some(Ok(ChatStreamEvent::Done { full_content, .. })) => {
                            return Ok(if full_content.is_empty() { content } else { full_content });
                        }
                        Some(Ok(ChatStreamEvent::Usage(_))) => {}
                        Some(Err(error)) => return Err(provider_summary_error(error)),
                        None => {
                            return Err(CompactionSummarizerError::generation(
                                "The compaction Provider stream ended without a terminal event",
                                true,
                            ));
                        }
                    }
                }
            }
        }
    };
    match tokio::time::timeout(COMPACTION_PROVIDER_TIMEOUT, operation).await {
        Ok(result) => result,
        Err(_) => {
            cancellation.cancel();
            Err(CompactionSummarizerError::generation(
                "The compaction Provider request timed out",
                true,
            ))
        }
    }
}

fn compaction_prompt(input: &CompactionSummaryInput) -> Result<String, CompactionSummarizerError> {
    let history = serde_json::to_string(&input.messages).map_err(|error| {
        CompactionSummarizerError::generation(
            format!("The compaction history could not be serialized: {error}"),
            false,
        )
    })?;
    if history.len() > MAX_COMPACTION_SOURCE_BYTES {
        return Err(CompactionSummarizerError::generation(
            "The compaction history exceeds the Provider input safety limit",
            false,
        ));
    }
    let previous_summary = input
        .previous_summary
        .as_ref()
        .map_or_else(|| "null".to_string(), serde_json::Value::to_string);
    let instructions = input.manual_instructions.as_deref().unwrap_or("");
    Ok(format!(
        "Previous summary:\n{previous_summary}\n\nManual instructions:\n{instructions}\n\nHistory to summarize (JSON):\n{history}\n\nReturn only the durable continuation summary as plain text."
    ))
}

fn provider_summary_error(error: ChatProviderError) -> CompactionSummarizerError {
    let retryable = matches!(
        error,
        ChatProviderError::RateLimit(_)
            | ChatProviderError::Network(_)
            | ChatProviderError::Cancelled
    );
    CompactionSummarizerError::generation(redact_sensitive_text(&error.to_string()), retryable)
}

fn validate_manual_instructions(value: Option<&str>) -> Result<(), AppError> {
    if value.is_some_and(|instructions| instructions.len() > MAX_MANUAL_INSTRUCTIONS_BYTES) {
        return Err(AppError::validation(
            "The compaction instructions exceed the safety limit",
        ));
    }
    Ok(())
}

fn compaction_response(result: CompactionResult) -> ChatCompactionResponse {
    let accepted = result.status == CompactionStatus::Completed;
    let reason = (!accepted).then(|| {
        result
            .message
            .clone()
            .unwrap_or_else(|| "Chat compaction failed".to_string())
    });
    ChatCompactionResponse {
        accepted,
        result: ChatCompactionResult {
            status: match result.status {
                CompactionStatus::Completed => "completed".to_string(),
                CompactionStatus::Failed => "failed".to_string(),
            },
            error_code: result.error_code.map(|code| code.to_string()),
            message: result.message,
            retryable: result.retryable,
            tokens_before: result.tokens_before,
            tokens_after: result.tokens_after,
            snapshot_status: result.snapshot_status.map(|status| match status {
                CompactionSnapshotStatus::Committed => "committed".to_string(),
                CompactionSnapshotStatus::Deferred => "deferred".to_string(),
            }),
            history_version: result.history_version,
        },
        reason,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        io::{self, Read, Write},
        net::{TcpListener, TcpStream},
        sync::{Arc, Mutex},
        thread::{self, JoinHandle},
        time::Duration,
    };

    use codez_core::{
        AppError, AtomicPersistence, PortFuture, SessionId,
        context::{
            ContextScopeId, LedgerAppendRequest, LedgerEventType, NormalizedModelMessage,
            UserMessagePayload,
        },
        provider::{
            ApiFormat, CredentialError, CredentialFuture, CredentialId, CredentialStore,
            ModelConfig, ProviderFormData, ProviderRepository, ProvidersFile, SecretValue,
            ThinkingConfig, ThinkingMode,
        },
    };
    use codez_providers::service::ProviderService;
    use codez_runtime::context::ledger::ModelLedgerStore;
    use codez_runtime::{
        context::compaction::{
            CompactionFailureCode, CompactionResult, CompactionSnapshotStatus, CompactionStatus,
        },
        session_maintenance::SessionMaintenanceCoordinator,
    };
    use codez_storage::AtomicFileStore;
    use serde_json::{Value, json};

    use super::{compact_chat_session, compaction_response};

    #[derive(Default)]
    struct MemoryProviderRepository {
        data: Mutex<Option<ProvidersFile>>,
    }

    impl ProviderRepository for MemoryProviderRepository {
        fn load(&self) -> PortFuture<'_, Option<ProvidersFile>> {
            Box::pin(async move {
                self.data
                    .lock()
                    .map(|data| data.clone())
                    .map_err(|_| AppError::storage("Provider fixture is unavailable", "read", true))
            })
        }

        fn save(&self, data: ProvidersFile) -> PortFuture<'_, ()> {
            Box::pin(async move {
                *self.data.lock().map_err(|_| {
                    AppError::storage("Provider fixture is unavailable", "write", true)
                })? = Some(data);
                Ok(())
            })
        }
    }

    #[derive(Default)]
    struct MemoryCredentialStore {
        values: Mutex<HashMap<CredentialId, String>>,
    }

    impl CredentialStore for MemoryCredentialStore {
        fn get(&self, id: CredentialId) -> CredentialFuture<'_, SecretValue> {
            Box::pin(async move {
                let value = self
                    .values
                    .lock()
                    .map_err(|_| CredentialError::Unavailable {
                        operation: "read local Provider credential",
                    })?
                    .get(&id)
                    .cloned()
                    .ok_or_else(|| CredentialError::NotFound { id: id.clone() })?;
                SecretValue::new(value)
            })
        }

        fn set(&self, id: CredentialId, value: SecretValue) -> CredentialFuture<'_, ()> {
            Box::pin(async move {
                self.values
                    .lock()
                    .map_err(|_| CredentialError::Unavailable {
                        operation: "write local Provider credential",
                    })?
                    .insert(id, value.expose_secret().to_string());
                Ok(())
            })
        }

        fn delete(&self, id: CredentialId) -> CredentialFuture<'_, ()> {
            Box::pin(async move {
                self.values
                    .lock()
                    .map_err(|_| CredentialError::Unavailable {
                        operation: "delete local Provider credential",
                    })?
                    .remove(&id)
                    .map(|_| ())
                    .ok_or(CredentialError::NotFound { id })
            })
        }
    }

    async fn local_provider(base_url: &str) -> (Arc<ProviderService>, String) {
        let service = Arc::new(
            ProviderService::new(
                Arc::new(MemoryProviderRepository::default()),
                Arc::new(MemoryCredentialStore::default()),
            )
            .await
            .expect("local Provider service must initialize"),
        );
        let provider = service
            .create(ProviderFormData {
                name: "Local Provider".to_string(),
                base_url: base_url.to_string(),
                api_format: Some(ApiFormat::Openai),
                api_key: Some(
                    SecretValue::new("local-compaction-test-secret")
                        .expect("fixture API key must be valid"),
                ),
                models: vec![ModelConfig {
                    id: "local-model".to_string(),
                    name: "local-model".to_string(),
                    max_context_tokens: 8_192,
                    max_input_tokens: None,
                    max_output_tokens: Some(512),
                    reasoning_counts_against_context: Some(false),
                    supports_vision: None,
                    api_format: Some(ApiFormat::Openai),
                    thinking_mode: None,
                    thinking_effort: None,
                    thinking_budget_tokens: None,
                }],
                thinking: ThinkingConfig {
                    enabled: false,
                    mode: ThinkingMode::None,
                    effort: None,
                    budget_tokens: None,
                },
            })
            .await
            .expect("local Provider configuration must persist");
        (service, provider.id)
    }

    struct LocalProviderServer {
        base_url: String,
        requests: Arc<Mutex<Vec<Value>>>,
        worker: Option<JoinHandle<io::Result<()>>>,
    }

    impl LocalProviderServer {
        fn start(response: String) -> Self {
            let listener =
                TcpListener::bind("127.0.0.1:0").expect("local Provider listener must bind");
            let address = listener
                .local_addr()
                .expect("local Provider listener must expose an address");
            let requests = Arc::new(Mutex::new(Vec::new()));
            let captured = Arc::clone(&requests);
            let worker = thread::spawn(move || {
                let (mut stream, _) = listener.accept()?;
                let request = read_json_request(&mut stream)?;
                captured
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(request);
                write_sse_response(&mut stream, &response)
            });
            Self {
                base_url: format!("http://{address}/v1"),
                requests,
                worker: Some(worker),
            }
        }

        fn finish(mut self) -> Vec<Value> {
            self.worker
                .take()
                .expect("local Provider worker must be present")
                .join()
                .expect("local Provider worker must not panic")
                .expect("local Provider worker must serve the summary request");
            self.requests
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }
    }

    fn read_json_request(stream: &mut TcpStream) -> io::Result<Value> {
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 4_096];
        let header_end = loop {
            let count = stream.read(&mut chunk)?;
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Provider request ended before headers",
                ));
            }
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let headers = std::str::from_utf8(&bytes[..header_end]).map_err(io::Error::other)?;
        let content_length = headers
            .lines()
            .find_map(|line| {
                line.split_once(':').and_then(|(name, value)| {
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
            })
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing content length"))?;
        while bytes.len() < header_end.saturating_add(content_length) {
            let count = stream.read(&mut chunk)?;
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Provider request ended before JSON body",
                ));
            }
            bytes.extend_from_slice(&chunk[..count]);
        }
        serde_json::from_slice(&bytes[header_end..header_end + content_length])
            .map_err(io::Error::other)
    }

    fn write_sse_response(stream: &mut TcpStream, body: &str) -> io::Result<()> {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes())?;
        stream.flush()
    }

    async fn seed_history(store: &ModelLedgerStore, provider_id: &str) {
        for index in 0..10 {
            let payload = UserMessagePayload {
                message: NormalizedModelMessage {
                    id: format!("message-{index}"),
                    client_message_id: None,
                    turn_id: "turn-1".to_string(),
                    role: "user".to_string(),
                    content: format!("message {index}: {}", "x".repeat(1_500)),
                    tool_calls: None,
                    tool_call_id: None,
                    name: None,
                    status: "complete".to_string(),
                    created_at: "2026-07-16T00:00:00.000Z".to_string(),
                    source_sequence: None,
                    attachments: None,
                    file_references: None,
                },
                provider_id: Some(provider_id.to_string()),
                model: Some("local-model".to_string()),
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
                    payload: serde_json::to_value(payload)
                        .expect("fixture history payload must serialize"),
                })
                .await
                .expect("fixture history must persist");
        }
    }

    #[test]
    fn completed_compaction_maps_to_an_accepted_chat_response() {
        let response = compaction_response(CompactionResult {
            status: CompactionStatus::Completed,
            error_code: None,
            message: None,
            retryable: None,
            tokens_before: Some(100),
            tokens_after: Some(40),
            snapshot_status: Some(CompactionSnapshotStatus::Committed),
            history_version: Some(3),
        });

        assert!(response.accepted);
    }

    #[test]
    fn failed_compaction_maps_the_durable_failure_reason() {
        let response = compaction_response(CompactionResult {
            status: CompactionStatus::Failed,
            error_code: Some(CompactionFailureCode::InsufficientHistory),
            message: Some("No session history is available to compact".to_string()),
            retryable: Some(false),
            tokens_before: None,
            tokens_after: None,
            snapshot_status: None,
            history_version: Some(2),
        });

        assert_eq!(
            response.reason.as_deref(),
            Some("No session history is available to compact")
        );
    }

    #[tokio::test]
    async fn local_provider_compaction_uses_the_ledger_provider_and_persists_the_summary() {
        let summary = "Durable summary from the local Provider.";
        let provider_response = format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({
                "choices": [{
                    "delta": {"content": summary},
                    "finish_reason": "stop"
                }]
            })
        );
        let server = LocalProviderServer::start(provider_response);
        let (providers, provider_id) = local_provider(&server.base_url).await;
        let directory = tempfile::tempdir().expect("temporary ledger directory must exist");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let ledger = Arc::new(ModelLedgerStore::new(directory.path(), persistence));
        seed_history(&ledger, &provider_id).await;
        let session_id = SessionId::parse("session-1").expect("fixture session ID must parse");
        let session_maintenance = SessionMaintenanceCoordinator::new();
        let exclusive_activity = session_maintenance
            .try_begin_exclusive_activity(session_id.clone())
            .expect("fixture compaction activity must begin");

        let response = compact_chat_session(
            providers,
            Arc::clone(&ledger),
            codez_core::CancellationToken::new(),
            exclusive_activity,
            Some("Keep the user decisions.".to_string()),
        )
        .await
        .expect("local Provider compaction must complete");

        assert!(response.accepted);
        let snapshot = ledger
            .get_snapshot(&session_id)
            .await
            .expect("compaction snapshot must load")
            .expect("compaction snapshot must exist");
        let compacted = snapshot
            .scopes
            .get("main")
            .and_then(|scope| scope.latest_compaction.as_ref())
            .expect("completed compaction must persist a summary");
        assert!(compacted.to_string().contains(summary));

        let requests = server.finish();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].get("tools").is_none());
        let messages = requests[0]["messages"]
            .as_array()
            .expect("compaction Provider request must contain messages");
        assert_eq!(messages[0]["role"], "system");
        assert!(
            messages[1]["content"]
                .as_str()
                .is_some_and(|content| content.contains("Keep the user decisions."))
        );
        assert!(
            session_maintenance
                .try_begin_maintenance(session_id)
                .is_ok()
        );
    }
}
