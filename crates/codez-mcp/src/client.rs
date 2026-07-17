#![expect(
    deprecated,
    reason = "MCP sampling remains protocol-compatible while policy-bound host execution is migrated"
)]

use std::{
    future::{Future, ready},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use rmcp::{
    ClientHandler, ErrorData as ProtocolError, RoleClient,
    model::{
        ClientCapabilities, ClientInfo, CreateMessageRequestMethod, CreateMessageRequestParams,
        CreateMessageResult, CustomNotification, ElicitRequestParams, ElicitResult,
        ElicitationAction, ElicitationCapability, FormElicitationCapability, Implementation,
        LoggingMessageNotificationParam, ProgressNotificationParam,
        ResourceUpdatedNotificationParam, SamplingCapability, UrlElicitationCapability,
    },
    service::{MaybeSendFuture, NotificationContext, RequestContext},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use url::Url;

use crate::{McpApprovalPolicy, McpServerConfig};

const DEFAULT_SAMPLING_MAX_TOKENS: u32 = 1_024;
const MAX_REVERSE_REQUEST_BYTES: usize = 128 * 1024;
const MAX_ELICITATION_REQUEST_BYTES: usize = 64 * 1024;
const MAX_SAMPLING_MESSAGES: usize = 64;
const MAX_ELICITATION_MESSAGE_BYTES: usize = 8 * 1024;
const MAX_ELICITATION_ID_BYTES: usize = 512;
const MAX_ELICITATION_URL_BYTES: usize = 8 * 1024;
const MAX_EVENT_TEXT_BYTES: usize = 8 * 1024;
const MAX_EVENT_DATA_BYTES: usize = 32 * 1024;

/// Kind of reverse request initiated by a connected MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpReverseRequestKind {
    Sampling,
    Elicitation,
}

/// Future returned by a policy-bound host reverse-request handler.
pub type McpReverseRequestFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, ProtocolError>> + Send + 'a>>;

/// Mediates reverse requests only after the configured policy and request limits allow it.
///
/// Implementations must perform the user-facing approval or provider execution. The MCP
/// transport never creates browser navigation, provider calls, or user answers by itself.
pub trait McpReverseRequestHandler: Send + Sync {
    /// Handles a validated, policy-approved sampling request.
    fn create_message(
        &self,
        request: CreateMessageRequestParams,
        policy: McpApprovalPolicy,
    ) -> McpReverseRequestFuture<'_, CreateMessageResult>;

    /// Handles a validated, policy-approved elicitation request.
    fn create_elicitation(
        &self,
        request: ElicitRequestParams,
        policy: McpApprovalPolicy,
    ) -> McpReverseRequestFuture<'_, ElicitResult>;
}

/// Per-server reverse-request policy, with an optional trusted host mediator.
///
/// A missing mediator is intentionally fail-closed. `ask` reports a typed pending
/// approval state, while `allow` reports that no host execution path is installed.
#[derive(Clone)]
pub struct McpReverseRequestPolicy {
    sampling: McpApprovalPolicy,
    elicitation: McpApprovalPolicy,
    sampling_max_tokens: u32,
    handler: Option<Arc<dyn McpReverseRequestHandler>>,
}

impl Default for McpReverseRequestPolicy {
    fn default() -> Self {
        Self::new(
            McpApprovalPolicy::Deny,
            McpApprovalPolicy::Deny,
            DEFAULT_SAMPLING_MAX_TOKENS,
        )
    }
}

impl McpReverseRequestPolicy {
    /// Creates a policy whose `ask` and `allow` branches remain disabled until a host handler is set.
    #[must_use]
    pub fn new(
        sampling: McpApprovalPolicy,
        elicitation: McpApprovalPolicy,
        sampling_max_tokens: u32,
    ) -> Self {
        Self {
            sampling,
            elicitation,
            sampling_max_tokens: sampling_max_tokens.max(1),
            handler: None,
        }
    }

    /// Converts a validated server configuration into a fail-closed runtime policy.
    #[must_use]
    pub fn from_server_config(config: &McpServerConfig) -> Self {
        let sampling_max_tokens = config
            .sampling_max_tokens
            .filter(|tokens| *tokens > 0)
            .unwrap_or(DEFAULT_SAMPLING_MAX_TOKENS);
        Self::new(
            config.sampling_policy.unwrap_or(McpApprovalPolicy::Deny),
            config.elicitation_policy.unwrap_or(McpApprovalPolicy::Deny),
            sampling_max_tokens,
        )
    }

    /// Adds the only component permitted to fulfill policy-approved reverse requests.
    #[must_use]
    pub fn with_handler(mut self, handler: Arc<dyn McpReverseRequestHandler>) -> Self {
        self.handler = Some(handler);
        self
    }

    fn handler_for(&self, policy: McpApprovalPolicy) -> Option<Arc<dyn McpReverseRequestHandler>> {
        (!matches!(policy, McpApprovalPolicy::Deny))
            .then(|| self.handler.clone())
            .flatten()
    }

    fn advertises_sampling(&self) -> bool {
        self.handler_for(self.sampling).is_some()
    }

    fn advertises_elicitation(&self) -> bool {
        self.handler_for(self.elicitation).is_some()
    }
}

/// Catalog category invalidated by a server notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpCatalogKind {
    Tools,
    Resources,
    Prompts,
}

/// Bounded, redacted events owned by one gateway connection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpEvent {
    Logging {
        level: String,
        logger: Option<String>,
        data: Value,
    },
    Progress {
        progress_token: Value,
        progress: f64,
        total: Option<f64>,
        message: Option<String>,
    },
    ResourceUpdated {
        uri: String,
    },
    CatalogChanged {
        catalog: McpCatalogKind,
    },
    CustomNotification {
        method: String,
    },
    ReverseRequestPending {
        kind: McpReverseRequestKind,
    },
    Overflow {
        dropped: u64,
    },
}

#[derive(Clone)]
pub(crate) struct EventRedactor {
    secrets: Arc<[String]>,
}

impl EventRedactor {
    pub(crate) fn new(secrets: impl IntoIterator<Item = String>) -> Self {
        let secrets = secrets
            .into_iter()
            .filter(|secret| secret.len() >= 3)
            .collect::<Vec<_>>();
        Self {
            secrets: secrets.into(),
        }
    }

    fn text(&self, value: &str) -> String {
        let mut redacted = value.to_owned();
        for secret in self.secrets.iter() {
            redacted = redacted.replace(secret, "[REDACTED]");
        }

        if let Ok(mut url) = Url::parse(&redacted) {
            if url.query().is_some() {
                url.set_query(Some("REDACTED"));
            }
            if url.fragment().is_some() {
                url.set_fragment(Some("REDACTED"));
            }
            return url.into();
        }
        redacted
    }

    fn bounded_text(&self, value: &str) -> String {
        let redacted = self.text(value);
        truncate_utf8(&redacted, MAX_EVENT_TEXT_BYTES)
    }

    fn value(&self, value: Value) -> Value {
        match value {
            Value::String(value) => Value::String(self.text(&value)),
            Value::Array(values) => {
                Value::Array(values.into_iter().map(|value| self.value(value)).collect())
            }
            Value::Object(values) => Value::Object(
                values
                    .into_iter()
                    .map(|(key, value)| {
                        if is_sensitive_key(&key) {
                            (key, Value::String("[REDACTED]".to_owned()))
                        } else {
                            (key, self.value(value))
                        }
                    })
                    .collect(),
            ),
            other => other,
        }
    }

    fn bounded_value(&self, value: Value) -> Value {
        let value = self.value(value);
        match serde_json::to_vec(&value) {
            Ok(serialized) if serialized.len() <= MAX_EVENT_DATA_BYTES => value,
            Ok(serialized) => Value::String(format!(
                "[MCP event data truncated: {} bytes]",
                serialized.len()
            )),
            Err(_) => Value::String("[MCP event data could not be encoded]".to_owned()),
        }
    }
}

fn truncate_utf8(value: &str, maximum_bytes: usize) -> String {
    if value.len() <= maximum_bytes {
        return value.to_owned();
    }

    let mut end = maximum_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}[truncated]", &value[..end])
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    [
        "authorization",
        "password",
        "secret",
        "token",
        "api_key",
        "api-key",
        "apikey",
    ]
    .iter()
    .any(|candidate| normalized.contains(candidate))
}

#[derive(Clone)]
pub(crate) struct CodezClientHandler {
    events: mpsc::Sender<McpEvent>,
    dropped_events: Arc<AtomicU64>,
    redactor: EventRedactor,
    reverse_requests: McpReverseRequestPolicy,
}

impl CodezClientHandler {
    pub(crate) fn new(
        event_capacity: usize,
        redactor: EventRedactor,
        reverse_requests: McpReverseRequestPolicy,
    ) -> (Self, mpsc::Receiver<McpEvent>, Arc<AtomicU64>) {
        let (events, receiver) = mpsc::channel(event_capacity);
        let dropped_events = Arc::new(AtomicU64::new(0));
        (
            Self {
                events,
                dropped_events: dropped_events.clone(),
                redactor,
                reverse_requests,
            },
            receiver,
            dropped_events,
        )
    }

    fn emit(&self, event: McpEvent) {
        if matches!(
            self.events.try_send(event),
            Err(mpsc::error::TrySendError::Full(_))
        ) {
            self.dropped_events.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn pending_approval(&self, kind: McpReverseRequestKind) -> ProtocolError {
        self.emit(McpEvent::ReverseRequestPending { kind });
        reverse_request_error(
            "MCP_APPROVAL_REQUIRED",
            "The MCP reverse request requires desktop approval.",
        )
    }
}

fn reverse_request_error(code: &'static str, message: &'static str) -> ProtocolError {
    ProtocolError::new(
        rmcp::model::ErrorCode(-32_000),
        message,
        Some(json!({ "code": code })),
    )
}

fn validate_sampling_request(
    request: &CreateMessageRequestParams,
    max_tokens: u32,
) -> Result<(), ProtocolError> {
    if request.max_tokens > max_tokens {
        return Err(ProtocolError::invalid_params(
            "The MCP sampling request exceeds the configured token limit.",
            Some(json!({ "limit": max_tokens })),
        ));
    }
    if request.messages.len() > MAX_SAMPLING_MESSAGES {
        return Err(ProtocolError::invalid_params(
            "The MCP sampling request contains too many messages.",
            Some(json!({ "limit": MAX_SAMPLING_MESSAGES })),
        ));
    }
    if request.tools.is_some() || request.tool_choice.is_some() {
        return Err(ProtocolError::invalid_params(
            "MCP sampling requests cannot define tools.",
            None,
        ));
    }
    request
        .validate()
        .map_err(|_| ProtocolError::invalid_params("The MCP sampling request is invalid.", None))?;
    validate_serialized_size(request, MAX_REVERSE_REQUEST_BYTES, "MCP sampling request")
}

fn validate_elicitation_request(request: &ElicitRequestParams) -> Result<(), ProtocolError> {
    match request {
        ElicitRequestParams::FormElicitationParams { message, .. } => {
            if message.len() > MAX_ELICITATION_MESSAGE_BYTES {
                return Err(ProtocolError::invalid_params(
                    "The MCP elicitation message is too large.",
                    Some(json!({ "limit": MAX_ELICITATION_MESSAGE_BYTES })),
                ));
            }
        }
        ElicitRequestParams::UrlElicitationParams {
            message,
            url,
            elicitation_id,
            ..
        } => {
            if message.len() > MAX_ELICITATION_MESSAGE_BYTES
                || url.len() > MAX_ELICITATION_URL_BYTES
                || elicitation_id.len() > MAX_ELICITATION_ID_BYTES
            {
                return Err(ProtocolError::invalid_params(
                    "The MCP elicitation request exceeds a configured limit.",
                    None,
                ));
            }
        }
        _ => {
            return Err(ProtocolError::invalid_params(
                "The MCP elicitation mode is unsupported.",
                None,
            ));
        }
    }
    validate_serialized_size(
        request,
        MAX_ELICITATION_REQUEST_BYTES,
        "MCP elicitation request",
    )
}

fn validate_reverse_response(
    response: &impl Serialize,
    maximum_bytes: usize,
) -> Result<(), ProtocolError> {
    validate_serialized_size(response, maximum_bytes, "MCP reverse-request response")
}

fn validate_serialized_size(
    value: &impl Serialize,
    maximum_bytes: usize,
    label: &'static str,
) -> Result<(), ProtocolError> {
    let serialized = serde_json::to_vec(value).map_err(|_| {
        reverse_request_error(
            "MCP_REVERSE_REQUEST_ENCODING_FAILED",
            "The MCP reverse request could not be encoded.",
        )
    })?;
    if serialized.len() > maximum_bytes {
        return Err(ProtocolError::invalid_params(
            format!("The {label} exceeds the configured size limit."),
            Some(json!({ "limit": maximum_bytes })),
        ));
    }
    Ok(())
}

impl ClientHandler for CodezClientHandler {
    fn get_info(&self) -> ClientInfo {
        let mut capabilities = ClientCapabilities::default();
        if self.reverse_requests.advertises_sampling() {
            capabilities.sampling = Some(SamplingCapability::default());
        }
        if self.reverse_requests.advertises_elicitation() {
            capabilities.elicitation = Some(
                ElicitationCapability::new()
                    .with_form(FormElicitationCapability::new().with_schema_validation(false))
                    .with_url(UrlElicitationCapability::new()),
            );
        }
        ClientInfo::new(
            capabilities,
            Implementation::new("CodeZ", env!("CARGO_PKG_VERSION")),
        )
    }

    #[expect(
        clippy::manual_async_fn,
        reason = "rmcp's ClientHandler contract requires a return-position future"
    )]
    fn create_message(
        &self,
        params: CreateMessageRequestParams,
        _context: RequestContext<RoleClient>,
    ) -> impl Future<Output = Result<CreateMessageResult, ProtocolError>> + MaybeSendFuture + '_
    {
        async move {
            let policy = self.reverse_requests.sampling;
            if matches!(policy, McpApprovalPolicy::Deny) {
                return Err(ProtocolError::method_not_found::<CreateMessageRequestMethod>());
            }
            validate_sampling_request(&params, self.reverse_requests.sampling_max_tokens)?;
            let Some(handler) = self.reverse_requests.handler_for(policy) else {
                return Err(match policy {
                    McpApprovalPolicy::Ask => {
                        self.pending_approval(McpReverseRequestKind::Sampling)
                    }
                    McpApprovalPolicy::Allow => reverse_request_error(
                        "MCP_REVERSE_REQUEST_EXECUTOR_UNAVAILABLE",
                        "No desktop MCP sampling executor is available.",
                    ),
                    McpApprovalPolicy::Deny => {
                        ProtocolError::method_not_found::<CreateMessageRequestMethod>()
                    }
                });
            };
            let response = handler.create_message(params, policy).await.map_err(|_| {
                reverse_request_error(
                    "MCP_REVERSE_REQUEST_EXECUTION_FAILED",
                    "The MCP sampling request could not be completed.",
                )
            })?;
            validate_reverse_response(&response, MAX_REVERSE_REQUEST_BYTES)?;
            Ok(response)
        }
    }

    #[expect(
        clippy::manual_async_fn,
        reason = "rmcp's ClientHandler contract requires a return-position future"
    )]
    fn create_elicitation(
        &self,
        request: ElicitRequestParams,
        _context: RequestContext<RoleClient>,
    ) -> impl Future<Output = Result<ElicitResult, ProtocolError>> + MaybeSendFuture + '_ {
        async move {
            let policy = self.reverse_requests.elicitation;
            if matches!(policy, McpApprovalPolicy::Deny) {
                return Ok(ElicitResult::new(ElicitationAction::Decline));
            }
            validate_elicitation_request(&request)?;
            let Some(handler) = self.reverse_requests.handler_for(policy) else {
                return Err(match policy {
                    McpApprovalPolicy::Ask => {
                        self.pending_approval(McpReverseRequestKind::Elicitation)
                    }
                    McpApprovalPolicy::Allow => reverse_request_error(
                        "MCP_REVERSE_REQUEST_EXECUTOR_UNAVAILABLE",
                        "No desktop MCP elicitation executor is available.",
                    ),
                    McpApprovalPolicy::Deny => ProtocolError::internal_error(
                        "The MCP elicitation request was denied.",
                        None,
                    ),
                });
            };
            let response = handler
                .create_elicitation(request, policy)
                .await
                .map_err(|_| {
                    reverse_request_error(
                        "MCP_REVERSE_REQUEST_EXECUTION_FAILED",
                        "The MCP elicitation request could not be completed.",
                    )
                })?;
            validate_reverse_response(&response, MAX_ELICITATION_REQUEST_BYTES)?;
            Ok(response)
        }
    }

    fn on_logging_message(
        &self,
        params: LoggingMessageNotificationParam,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        self.emit(McpEvent::Logging {
            level: format!("{:?}", params.level).to_ascii_lowercase(),
            logger: params
                .logger
                .map(|logger| self.redactor.bounded_text(&logger)),
            data: self.redactor.bounded_value(params.data),
        });
        ready(())
    }

    fn on_progress(
        &self,
        params: ProgressNotificationParam,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        let token = serde_json::to_value(params.progress_token)
            .unwrap_or_else(|_| Value::String("[invalid progress token]".to_owned()));
        self.emit(McpEvent::Progress {
            progress_token: self.redactor.bounded_value(token),
            progress: params.progress,
            total: params.total,
            message: params
                .message
                .map(|message| self.redactor.bounded_text(&message)),
        });
        ready(())
    }

    fn on_resource_updated(
        &self,
        params: ResourceUpdatedNotificationParam,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        self.emit(McpEvent::ResourceUpdated {
            uri: self.redactor.bounded_text(&params.uri),
        });
        ready(())
    }

    fn on_resource_list_changed(
        &self,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        self.emit(McpEvent::CatalogChanged {
            catalog: McpCatalogKind::Resources,
        });
        ready(())
    }

    fn on_tool_list_changed(
        &self,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        self.emit(McpEvent::CatalogChanged {
            catalog: McpCatalogKind::Tools,
        });
        ready(())
    }

    fn on_prompt_list_changed(
        &self,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        self.emit(McpEvent::CatalogChanged {
            catalog: McpCatalogKind::Prompts,
        });
        ready(())
    }

    fn on_custom_notification(
        &self,
        notification: CustomNotification,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        self.emit(McpEvent::CustomNotification {
            method: self.redactor.bounded_text(&notification.method),
        });
        ready(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use rmcp::{
        ServerHandler, ServiceError, ServiceExt,
        model::{
            CreateMessageRequestParams, CreateMessageResult, ElicitRequestParams, ElicitResult,
            ElicitationAction, SamplingMessage,
        },
    };
    use serde_json::json;
    use tokio::io::duplex;

    use crate::McpApprovalPolicy;

    use super::{
        CodezClientHandler, EventRedactor, McpEvent, McpReverseRequestFuture,
        McpReverseRequestHandler, McpReverseRequestKind, McpReverseRequestPolicy,
    };

    type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

    struct ReverseRequestServer;

    impl ServerHandler for ReverseRequestServer {}

    #[derive(Default)]
    struct AllowingHandler {
        sampling_calls: AtomicUsize,
    }

    impl McpReverseRequestHandler for AllowingHandler {
        fn create_message(
            &self,
            _request: CreateMessageRequestParams,
            policy: McpApprovalPolicy,
        ) -> McpReverseRequestFuture<'_, CreateMessageResult> {
            self.sampling_calls.fetch_add(1, Ordering::AcqRel);
            Box::pin(async move {
                assert_eq!(policy, McpApprovalPolicy::Allow);
                Ok(CreateMessageResult::new(
                    SamplingMessage::assistant_text("approved"),
                    "codez-test-model".to_string(),
                ))
            })
        }

        fn create_elicitation(
            &self,
            _request: ElicitRequestParams,
            _policy: McpApprovalPolicy,
        ) -> McpReverseRequestFuture<'_, ElicitResult> {
            Box::pin(async { Ok(ElicitResult::new(ElicitationAction::Decline)) })
        }
    }

    fn client_handler(
        policy: McpReverseRequestPolicy,
    ) -> (CodezClientHandler, tokio::sync::mpsc::Receiver<McpEvent>) {
        let (handler, events, _dropped_events) =
            CodezClientHandler::new(4, EventRedactor::new(std::iter::empty()), policy);
        (handler, events)
    }

    #[test]
    fn redactor_removes_configured_secrets_sensitive_fields_and_url_queries() {
        let redactor = EventRedactor::new(["mcp-secret".to_owned()]);
        let value = json!({
            "message": "token=mcp-secret",
            "apiKey": "another-secret",
            "url": "https://example.test/path?token=mcp-secret#fragment"
        });

        let redacted = redactor.value(value);

        assert_eq!(redacted["message"], "token=[REDACTED]");
        assert_eq!(redacted["apiKey"], "[REDACTED]");
        assert_eq!(
            redacted["url"],
            "https://example.test/path?REDACTED#REDACTED"
        );
    }

    #[tokio::test]
    async fn ask_policy_reports_typed_pending_state_without_a_host_mediator() -> TestResult {
        let (server_transport, client_transport) = duplex(4096);
        let server_task = tokio::spawn(async move {
            let server = ReverseRequestServer.serve(server_transport).await?;
            let sampling = server
                .create_message(CreateMessageRequestParams::new(
                    vec![SamplingMessage::user_text("sample this")],
                    16,
                ))
                .await
                .expect_err("sampling without a host mediator must remain pending");
            let elicitation = server
                .create_elicitation(ElicitRequestParams::UrlElicitationParams {
                    meta: None,
                    message: "Authenticate".to_string(),
                    url: "https://login.example.test/start".to_string(),
                    elicitation_id: "elicitation-1".to_string(),
                })
                .await
                .expect_err("elicitation without a host mediator must remain pending");
            server.cancel().await?;
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>((sampling, elicitation))
        });
        let policy =
            McpReverseRequestPolicy::new(McpApprovalPolicy::Ask, McpApprovalPolicy::Ask, 16);
        let (handler, mut events) = client_handler(policy);
        let client = handler.serve(client_transport).await?;
        let (sampling, elicitation) = server_task.await??;
        client.cancel().await?;

        let ServiceError::McpError(sampling) = sampling else {
            return Err("sampling did not return a protocol error".into());
        };
        let ServiceError::McpError(elicitation) = elicitation else {
            return Err("elicitation did not return a protocol error".into());
        };

        assert_eq!(
            sampling.data,
            Some(json!({ "code": "MCP_APPROVAL_REQUIRED" }))
        );
        assert_eq!(
            elicitation.data,
            Some(json!({ "code": "MCP_APPROVAL_REQUIRED" }))
        );
        assert!(matches!(
            events.recv().await,
            Some(McpEvent::ReverseRequestPending {
                kind: McpReverseRequestKind::Sampling
            })
        ));
        assert!(matches!(
            events.recv().await,
            Some(McpEvent::ReverseRequestPending {
                kind: McpReverseRequestKind::Elicitation
            })
        ));
        Ok(())
    }

    #[tokio::test]
    async fn allow_policy_invokes_only_the_explicit_host_mediator() -> TestResult {
        let (server_transport, client_transport) = duplex(4096);
        let server_task = tokio::spawn(async move {
            let server = ReverseRequestServer.serve(server_transport).await?;
            let response = server
                .create_message(CreateMessageRequestParams::new(
                    vec![SamplingMessage::user_text("sample this")],
                    16,
                ))
                .await?;
            server.cancel().await?;
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>(response)
        });
        let allowing_handler = Arc::new(AllowingHandler::default());
        let policy =
            McpReverseRequestPolicy::new(McpApprovalPolicy::Allow, McpApprovalPolicy::Deny, 16)
                .with_handler(allowing_handler.clone());
        let (handler, _events) = client_handler(policy);
        let client = handler.serve(client_transport).await?;
        let response = server_task.await??;
        client.cancel().await?;

        assert_eq!(response.model, "codez-test-model");
        assert_eq!(allowing_handler.sampling_calls.load(Ordering::Acquire), 1);
        Ok(())
    }

    #[tokio::test]
    async fn sampling_token_limit_rejects_before_invoking_the_host_mediator() -> TestResult {
        let (server_transport, client_transport) = duplex(4096);
        let server_task = tokio::spawn(async move {
            let server = ReverseRequestServer.serve(server_transport).await?;
            let error = server
                .create_message(CreateMessageRequestParams::new(
                    vec![SamplingMessage::user_text("sample this")],
                    17,
                ))
                .await
                .expect_err("sampling above the configured token limit must be rejected");
            server.cancel().await?;
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>(error)
        });
        let allowing_handler = Arc::new(AllowingHandler::default());
        let policy =
            McpReverseRequestPolicy::new(McpApprovalPolicy::Allow, McpApprovalPolicy::Deny, 16)
                .with_handler(allowing_handler.clone());
        let (handler, _events) = client_handler(policy);
        let client = handler.serve(client_transport).await?;
        let error = server_task.await??;
        client.cancel().await?;

        let ServiceError::McpError(error) = error else {
            return Err("sampling limit did not return a protocol error".into());
        };

        assert_eq!(error.data, Some(json!({ "limit": 16 })));
        assert_eq!(allowing_handler.sampling_calls.load(Ordering::Acquire), 0);
        Ok(())
    }
}
