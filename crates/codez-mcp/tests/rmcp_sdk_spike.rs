#![expect(
    deprecated,
    reason = "the spike must verify CodeZ compatibility with MCP logging, roots, and sampling"
)]

use std::{
    future::{Future, ready},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use rmcp::{
    ClientHandler, ErrorData as McpError, RoleClient, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, ClientCapabilities, ClientInfo, CreateMessageRequestParams,
        CreateMessageResult, CustomNotification, ElicitRequestParams, ElicitResult,
        ElicitationAction, ElicitationCapability, FormElicitationCapability,
        GetPromptRequestParams, Implementation, LoggingLevel, LoggingMessageNotificationParam,
        ReadResourceRequestParams, ResourceUpdatedNotificationParam, RootsCapabilities,
        SamplingCapability, SamplingMessage, ServerJsonRpcMessage, ServerNotification,
        SetLevelRequestParams, SubscribeRequestParams, UnsubscribeRequestParams,
        UrlElicitationCapability,
    },
    service::{MaybeSendFuture, NotificationContext, RequestContext},
    transport::{
        ConfigureCommandExt, StreamableHttpClientTransport, TokioChildProcess,
        auth::{AuthError, CredentialStore, OAuthState, StoredCredentials},
        streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::{Child, Command},
    sync::RwLock,
    time::{sleep, timeout},
};
type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;
const MAX_CAPTURED_STDERR_BYTES: usize = 8 * 1024;

#[derive(Clone, Default)]
struct ProbeClient {
    logs: Arc<Mutex<Vec<LoggingMessageNotificationParam>>>,
    resource_updates: Arc<Mutex<Vec<String>>>,
    custom_notifications: Arc<Mutex<Vec<String>>>,
}

impl ClientHandler for ProbeClient {
    fn get_info(&self) -> ClientInfo {
        let mut capabilities = ClientCapabilities::default();
        let mut roots = RootsCapabilities::default();
        roots.list_changed = Some(true);
        capabilities.roots = Some(roots);
        capabilities.sampling = Some(SamplingCapability::default());
        capabilities.elicitation = Some(
            ElicitationCapability::new()
                .with_form(FormElicitationCapability::new().with_schema_validation(false))
                .with_url(UrlElicitationCapability::new()),
        );
        ClientInfo::new(
            capabilities,
            Implementation::new("codez-rmcp-spike", env!("CARGO_PKG_VERSION")),
        )
    }

    fn create_message(
        &self,
        _params: CreateMessageRequestParams,
        _context: RequestContext<RoleClient>,
    ) -> impl Future<Output = Result<CreateMessageResult, McpError>> + MaybeSendFuture + '_ {
        ready(Ok(CreateMessageResult::new(
            SamplingMessage::assistant_text("spike response"),
            "codez-spike-model".to_owned(),
        )))
    }

    fn create_elicitation(
        &self,
        _request: ElicitRequestParams,
        _context: RequestContext<RoleClient>,
    ) -> impl Future<Output = Result<ElicitResult, McpError>> + MaybeSendFuture + '_ {
        ready(Ok(ElicitResult::new(ElicitationAction::Decline)))
    }

    async fn on_logging_message(
        &self,
        params: LoggingMessageNotificationParam,
        _context: NotificationContext<RoleClient>,
    ) {
        self.logs.lock().expect("log mutex poisoned").push(params);
    }

    async fn on_resource_updated(
        &self,
        params: ResourceUpdatedNotificationParam,
        _context: NotificationContext<RoleClient>,
    ) {
        self.resource_updates
            .lock()
            .expect("resource update mutex poisoned")
            .push(params.uri);
    }

    async fn on_custom_notification(
        &self,
        notification: CustomNotification,
        _context: NotificationContext<RoleClient>,
    ) {
        self.custom_notifications
            .lock()
            .expect("custom notification mutex poisoned")
            .push(notification.method);
    }
}

#[derive(Clone, Default)]
struct ProbeCredentialStore(Arc<RwLock<Option<StoredCredentials>>>);

struct ReverseRequestServer;

impl ServerHandler for ReverseRequestServer {}

#[async_trait::async_trait]
impl CredentialStore for ProbeCredentialStore {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        Ok(self.0.read().await.clone())
    }

    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        *self.0.write().await = Some(credentials);
        Ok(())
    }

    async fn clear(&self) -> Result<(), AuthError> {
        *self.0.write().await = None;
        Ok(())
    }
}

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("codez-mcp must be inside the workspace crates directory")
        .to_path_buf()
}

fn fixture(name: &str) -> PathBuf {
    workspace_root().join("src/tests/fixtures").join(name)
}

fn arguments(value: Value) -> serde_json::Map<String, Value> {
    let Value::Object(arguments) = value else {
        panic!("tool arguments must be a JSON object");
    };
    arguments
}

fn content_text(result: &rmcp::model::CallToolResult) -> Option<&str> {
    result
        .content
        .iter()
        .find_map(|content| content.as_text().map(|text| text.text.as_str()))
}

async fn wait_until(label: &str, mut predicate: impl FnMut() -> bool) -> TestResult {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !predicate() {
        if Instant::now() >= deadline {
            return Err(format!("{label} was not satisfied before the timeout").into());
        }
        sleep(Duration::from_millis(20)).await;
    }
    Ok(())
}

#[cfg(windows)]
fn process_exists(pid: u32) -> bool {
    let output = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .expect("tasklist must be available on Windows");
    String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
}

#[cfg(not(windows))]
fn process_exists(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|status| status.success())
}

async fn wait_for_process_exit(pid: u32) -> TestResult {
    wait_until("child process exit", || !process_exists(pid)).await
}

async fn drain_bounded_stderr(mut stderr: tokio::process::ChildStderr) -> std::io::Result<Vec<u8>> {
    let mut captured = Vec::with_capacity(MAX_CAPTURED_STDERR_BYTES);
    let mut chunk = [0_u8; 1024];
    loop {
        let read = stderr.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        let remaining = MAX_CAPTURED_STDERR_BYTES.saturating_sub(captured.len());
        captured.extend_from_slice(&chunk[..read.min(remaining)]);
    }
    Ok(captured)
}

async fn start_node_fixture(name: &str, address_field: &str) -> TestResult<(Child, String)> {
    let mut command = Command::new("node");
    command
        .arg(fixture(name))
        .current_dir(workspace_root())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Node fixture stdout was not piped")?;
    let mut lines = BufReader::new(stdout).lines();
    let line = timeout(Duration::from_secs(5), lines.next_line())
        .await
        .map_err(|_| "Node fixture did not report its address")??
        .ok_or("Node fixture exited before reporting its address")?;
    let message: Value = serde_json::from_str(&line)?;
    let address = message[address_field]
        .as_str()
        .ok_or("Node fixture did not report the expected address")?
        .to_owned();
    Ok((child, address))
}

async fn start_http_fixture() -> TestResult<(Child, String)> {
    start_node_fixture("mcp-streamable-http-server.cjs", "url").await
}

#[tokio::test]
async fn interoperates_with_existing_javascript_stdio_fixture() -> TestResult {
    let probe = ProbeClient::default();
    let transport = TokioChildProcess::new(Command::new("node").configure(|command| {
        command
            .arg(fixture("mcp-stdio-server.cjs"))
            .current_dir(workspace_root())
            .env("CODEZ_MCP_TEST_TOKEN", "rmcp-spike-secret");
    }))?;
    let client = probe.clone().serve(transport).await?;

    let server_info = client.peer().peer_info().ok_or("missing server info")?;
    assert_eq!(server_info.server_info.name, "codez-test-server");
    assert_eq!(
        server_info.instructions.as_deref(),
        Some("Use the echo tool when the user asks to repeat text.")
    );

    let tools = client.list_all_tools().await?;
    assert_eq!(tools.len(), 4);
    assert!(tools.iter().any(|tool| tool.name == "echo"));
    let resources = client.list_all_resources().await?;
    assert!(
        resources
            .iter()
            .any(|resource| resource.uri == "test://example")
    );
    let templates = client.list_all_resource_templates().await?;
    assert!(
        templates
            .iter()
            .any(|template| template.uri_template == "test://items/{id}")
    );
    let prompts = client.list_all_prompts().await?;
    assert!(prompts.iter().any(|prompt| prompt.name == "review"));

    let echo = client
        .call_tool(
            CallToolRequestParams::new("echo")
                .with_arguments(arguments(json!({ "message": "hello" }))),
        )
        .await?;
    assert_eq!(content_text(&echo), Some("echo:hello"));

    let resource = client
        .read_resource(ReadResourceRequestParams::new("test://items/42"))
        .await?;
    assert_eq!(
        serde_json::to_value(resource)?["contents"][0]["text"],
        "item:42"
    );

    let prompt = client
        .get_prompt(
            GetPromptRequestParams::new("review")
                .with_arguments(arguments(json!({ "subject": "runtime" }))),
        )
        .await?;
    assert_eq!(
        serde_json::to_value(prompt)?["messages"][0]["content"]["text"],
        "Review runtime"
    );

    client
        .set_level(SetLevelRequestParams::new(LoggingLevel::Debug))
        .await?;
    client
        .call_tool(CallToolRequestParams::new("log_secret").with_arguments(arguments(json!({}))))
        .await?;
    let log_wait = wait_until("secret log notification", || {
        !probe.logs.lock().expect("log mutex poisoned").is_empty()
    })
    .await;
    if log_wait.is_err() {
        return Err(format!(
            "secret log notification timed out; closed={}, custom={:?}",
            client.is_closed(),
            probe
                .custom_notifications
                .lock()
                .expect("custom notification mutex poisoned")
        )
        .into());
    }
    let raw_logs = serde_json::to_string(&*probe.logs.lock().expect("log mutex poisoned"))?;
    assert!(raw_logs.contains("rmcp-spike-secret"));

    client
        .call_tool(CallToolRequestParams::new("flood_logs").with_arguments(arguments(json!({}))))
        .await?;
    wait_until("log flood delivery", || {
        probe.logs.lock().expect("log mutex poisoned").len() >= 251
    })
    .await?;

    let pid_result = client
        .call_tool(CallToolRequestParams::new("pid").with_arguments(arguments(json!({}))))
        .await?;
    let pid = content_text(&pid_result)
        .and_then(|text| text.strip_prefix("pid:"))
        .ok_or("stdio fixture returned an invalid PID")?
        .parse::<u32>()?;
    assert!(process_exists(pid));
    client.cancel().await?;
    wait_for_process_exit(pid).await?;
    Ok(())
}

#[tokio::test]
async fn bounds_stdio_handshake_and_cleans_up_the_child() -> TestResult {
    let transport = TokioChildProcess::new(Command::new("node").configure(|command| {
        command
            .arg(fixture("mcp-stdio-hang.cjs"))
            .current_dir(workspace_root());
    }))?;
    let pid = transport.id().ok_or("hanging fixture did not have a PID")?;
    assert!(process_exists(pid));

    let result = timeout(
        Duration::from_millis(150),
        ProbeClient::default().serve(transport),
    )
    .await;
    assert!(
        result.is_err(),
        "the hanging handshake unexpectedly completed"
    );
    wait_for_process_exit(pid).await?;
    Ok(())
}

#[tokio::test]
async fn stdio_stderr_capture_should_remain_bounded_when_child_floods() -> TestResult {
    let (transport, stderr) =
        TokioChildProcess::builder(Command::new("node").configure(|command| {
            command
                .arg(fixture("mcp-stdio-failure.cjs"))
                .current_dir(workspace_root());
        }))
        .stderr(Stdio::piped())
        .spawn()?;
    let stderr = stderr.ok_or("failure fixture stderr was not piped")?;
    let stderr_task = tokio::spawn(drain_bounded_stderr(stderr));

    let connection = ProbeClient::default().serve(transport).await;
    assert!(
        connection.is_err(),
        "the failing fixture unexpectedly connected"
    );
    let captured = stderr_task.await??;
    assert_eq!(captured.len(), MAX_CAPTURED_STDERR_BYTES);
    assert!(String::from_utf8_lossy(&captured).starts_with("failure-line-0-"));
    Ok(())
}

#[tokio::test]
async fn reverse_requests_should_reach_sampling_and_elicitation_handlers() -> TestResult {
    let (server_transport, client_transport) = tokio::io::duplex(4096);
    let server_task = tokio::spawn(async move {
        let server = ReverseRequestServer.serve(server_transport).await?;
        let sampling = server
            .create_message(CreateMessageRequestParams::new(
                vec![SamplingMessage::user_text("sample this")],
                32,
            ))
            .await?;
        let elicitation = server
            .create_elicitation(ElicitRequestParams::UrlElicitationParams {
                meta: None,
                message: "Authenticate".to_owned(),
                url: "https://login.example.test/start".to_owned(),
                elicitation_id: "elicitation-1".to_owned(),
            })
            .await?;
        server.cancel().await?;
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>((sampling, elicitation))
    });

    let client = ProbeClient::default().serve(client_transport).await?;
    let (sampling, elicitation) = server_task.await??;
    client.cancel().await?;

    assert_eq!(sampling.model, "codez-spike-model");
    assert_eq!(elicitation.action, ElicitationAction::Decline);
    Ok(())
}

#[tokio::test]
async fn validates_streamable_http_notifications_and_session_recovery() -> TestResult {
    let (mut server, url) = start_http_fixture().await?;
    let probe = ProbeClient::default();
    let config = StreamableHttpClientTransportConfig::with_uri(url).reinit_on_expired_session(true);
    let transport = StreamableHttpClientTransport::from_config(config);
    let client = probe.clone().serve(transport).await?;

    let server_info = client
        .peer()
        .peer_info()
        .ok_or("missing HTTP server info")?;
    assert_eq!(server_info.server_info.name, "codez-rmcp-http-spike");
    assert!(
        client
            .list_all_tools()
            .await?
            .iter()
            .any(|tool| tool.name == "echo")
    );
    assert!(
        client
            .list_all_resources()
            .await?
            .iter()
            .any(|resource| resource.uri == "test://base")
    );
    assert!(
        client
            .list_all_prompts()
            .await?
            .iter()
            .any(|prompt| prompt.name == "review")
    );

    let first = client
        .call_tool(
            CallToolRequestParams::new("echo")
                .with_arguments(arguments(json!({ "message": "before" }))),
        )
        .await?;
    assert_eq!(content_text(&first), Some("http:before:session:1"));

    client
        .subscribe(SubscribeRequestParams::new("test://base"))
        .await?;
    client
        .call_tool(
            CallToolRequestParams::new("notify_resource").with_arguments(arguments(json!({}))),
        )
        .await?;
    let update_wait = wait_until("resource update notification", || {
        probe
            .resource_updates
            .lock()
            .expect("resource update mutex poisoned")
            .iter()
            .any(|uri| uri == "test://base")
    })
    .await;
    if update_wait.is_err() {
        return Err(format!(
            "resource update notification timed out; closed={}, custom={:?}",
            client.is_closed(),
            probe
                .custom_notifications
                .lock()
                .expect("custom notification mutex poisoned")
        )
        .into());
    }
    client
        .unsubscribe(UnsubscribeRequestParams::new("test://base"))
        .await?;

    client
        .call_tool(
            CallToolRequestParams::new("expire_session").with_arguments(arguments(json!({}))),
        )
        .await?;
    let recovered = client
        .call_tool(
            CallToolRequestParams::new("echo")
                .with_arguments(arguments(json!({ "message": "recovered" }))),
        )
        .await?;
    assert_eq!(content_text(&recovered), Some("http:recovered:session:2"));

    client
        .call_tool(
            CallToolRequestParams::new("arm_generic_404").with_arguments(arguments(json!({}))),
        )
        .await?;
    let overly_broad_recovery = client
        .call_tool(
            CallToolRequestParams::new("echo")
                .with_arguments(arguments(json!({ "message": "generic" }))),
        )
        .await?;
    assert_eq!(
        content_text(&overly_broad_recovery),
        Some("http:generic:session:3")
    );

    client.cancel().await?;
    server.kill().await?;
    server.wait().await?;
    Ok(())
}

#[test]
fn standard_logging_notification_should_deserialize_to_typed_variant() -> TestResult {
    let logging: ServerJsonRpcMessage = serde_json::from_value(json!({
        "jsonrpc": "2.0",
        "method": "notifications/message",
        "params": { "level": "info", "data": "test" }
    }))?;
    assert!(matches!(
        logging,
        ServerJsonRpcMessage::Notification(notification)
            if matches!(
                notification.notification,
                ServerNotification::LoggingMessageNotification(_)
            )
    ));

    Ok(())
}

#[test]
fn standard_resource_update_notification_should_deserialize_to_typed_variant() -> TestResult {
    let update: ServerJsonRpcMessage = serde_json::from_value(json!({
        "jsonrpc": "2.0",
        "method": "notifications/resources/updated",
        "params": { "uri": "test://base" }
    }))?;
    assert!(matches!(
        update,
        ServerJsonRpcMessage::Notification(notification)
            if matches!(
                notification.notification,
                ServerNotification::ResourceUpdatedNotification(_)
            )
    ));
    Ok(())
}

#[tokio::test]
async fn oauth_flow_should_discover_authorize_persist_and_refresh() -> TestResult {
    let (mut server, origin) = start_node_fixture("mcp-oauth-server.cjs", "origin").await?;
    let store = ProbeCredentialStore::default();
    let mut oauth = OAuthState::new(format!("{origin}/mcp"), None).await?;
    let OAuthState::Unauthorized(manager) = &mut oauth else {
        return Err("new OAuth state was not unauthorized".into());
    };
    manager.set_credential_store(store.clone());
    oauth
        .start_authorization(
            &["mcp"],
            "http://127.0.0.1:43119/callback",
            Some("CodeZ MCP spike"),
        )
        .await?;

    let authorization_url = oauth.get_authorization_url().await?;
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let authorization = http.get(authorization_url).send().await?;
    assert_eq!(authorization.status(), reqwest::StatusCode::FOUND);
    let callback_url = authorization
        .headers()
        .get(reqwest::header::LOCATION)
        .ok_or("authorization server did not return a callback")?
        .to_str()?;
    oauth.handle_callback_url(callback_url).await?;

    let first_credentials = store
        .load()
        .await?
        .ok_or("OAuth flow did not persist credentials")?;
    let first_json = serde_json::to_value(&first_credentials)?;
    assert_eq!(first_json["token_response"]["access_token"], "access-1");
    assert!(!format!("{first_credentials:?}").contains("access-1"));

    oauth.refresh_token().await?;
    let refreshed = store
        .load()
        .await?
        .ok_or("OAuth refresh did not persist credentials")?;
    let refreshed_json = serde_json::to_value(refreshed)?;
    assert_eq!(refreshed_json["token_response"]["access_token"], "access-2");

    server.kill().await?;
    server.wait().await?;
    Ok(())
}
