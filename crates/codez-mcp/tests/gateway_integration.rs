use std::{
    collections::BTreeMap,
    env,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use codez_mcp::{
    McpError, McpEvent, McpGateway, McpGatewayLimits, McpServerId, McpTimeouts, StdioServerConfig,
    StreamableHttpServerConfig,
};
use serde_json::{Map, Value, json};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};
use tokio_util::sync::CancellationToken;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("codez-mcp must be in the workspace crates directory")
        .to_path_buf()
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn node_executable() -> TestResult<PathBuf> {
    let executable_name = if cfg!(windows) { "node.exe" } else { "node" };
    let path =
        env::var_os("PATH").ok_or("PATH is required to locate the Node test fixture host")?;
    for directory in env::split_paths(&path) {
        let candidate = directory.join(executable_name);
        if candidate.is_file() {
            return Ok(std::fs::canonicalize(candidate)?);
        }
    }
    Err("Node executable was not found on PATH".into())
}

fn explicit_test_environment() -> BTreeMap<OsString, OsString> {
    [
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "PATH",
    ]
    .into_iter()
    .filter_map(|key| env::var_os(key).map(|value| (OsString::from(key), value)))
    .collect()
}

fn test_gateway() -> McpGateway {
    McpGateway::with_config(
        McpTimeouts::new(
            Duration::from_secs(5),
            Duration::from_secs(5),
            Duration::from_secs(3),
        )
        .expect("test timeout configuration should be valid"),
        McpGatewayLimits::new(16, 16, 100, 10).expect("test gateway limits should be valid"),
    )
}

fn arguments(value: Value) -> Map<String, Value> {
    let Value::Object(arguments) = value else {
        panic!("tool arguments must be an object");
    };
    arguments
}

fn result_text(result: &rmcp::model::CallToolResult) -> Option<&str> {
    result
        .content
        .iter()
        .find_map(|content| content.as_text().map(|text| text.text.as_str()))
}

fn stdio_config(fixture_name: &str) -> TestResult<StdioServerConfig> {
    let mut environment = explicit_test_environment();
    environment.insert(
        OsString::from("CODEZ_MCP_TEST_TOKEN"),
        OsString::from("production-gateway-secret"),
    );
    Ok(StdioServerConfig::new(
        node_executable()?,
        vec![fixture(fixture_name).into_os_string()],
        environment,
        Some(workspace_root()),
    )?)
}

async fn start_http_fixture() -> TestResult<(Child, String)> {
    start_network_fixture("mcp-streamable-http-server.cjs").await
}

async fn start_legacy_sse_fixture() -> TestResult<(Child, String)> {
    start_network_fixture("mcp-legacy-sse-server.cjs").await
}

async fn start_network_fixture(fixture_name: &str) -> TestResult<(Child, String)> {
    let mut command = Command::new(node_executable()?);
    command
        .arg(fixture(fixture_name))
        .current_dir(workspace_root())
        .env_clear()
        .envs(explicit_test_environment())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or("network fixture stdout was not piped")?;
    let mut lines = BufReader::new(stdout).lines();
    let line = timeout(Duration::from_secs(5), lines.next_line())
        .await
        .map_err(|_| "network fixture did not report its address")??
        .ok_or("network fixture exited before reporting its address")?;
    let message: Value = serde_json::from_str(&line)?;
    let endpoint = message["url"]
        .as_str()
        .ok_or("network fixture address was invalid")?
        .to_owned();
    Ok((child, endpoint))
}

#[tokio::test]
async fn production_stdio_gateway_executes_typed_operations_and_cleans_up() -> TestResult {
    let gateway = test_gateway();
    let server_id = McpServerId::new("stdio-fixture")?;
    let cancellation = CancellationToken::new();
    let info = gateway
        .connect_stdio(
            server_id.clone(),
            stdio_config("mcp-stdio-server.cjs")?,
            &cancellation,
        )
        .await?;
    assert_eq!(info.server.server_info.name, "codez-test-server");
    let pid = info
        .process_id
        .ok_or("stdio connection did not report a PID")?;
    assert_ne!(pid, 0, "stdio connection reported an invalid PID");

    let catalog = gateway.list_catalog(&server_id, &cancellation).await?;
    assert!(catalog.tools.iter().any(|tool| tool.name == "echo"));
    assert!(
        catalog
            .resources
            .iter()
            .any(|resource| resource.uri == "test://example")
    );
    assert!(
        catalog
            .resource_templates
            .iter()
            .any(|template| template.uri_template == "test://items/{id}")
    );
    assert!(catalog.prompts.iter().any(|prompt| prompt.name == "review"));

    let echo = gateway
        .call_tool(
            &server_id,
            "echo",
            arguments(json!({ "message": "hello" })),
            &cancellation,
        )
        .await?;
    assert_eq!(result_text(&echo), Some("echo:hello"));
    let resource = gateway
        .read_resource(&server_id, "test://items/42", &cancellation)
        .await?;
    assert_eq!(
        serde_json::to_value(resource)?["contents"][0]["text"],
        "item:42"
    );
    let prompt = gateway
        .get_prompt(
            &server_id,
            "review",
            arguments(json!({ "subject": "runtime" })),
            &cancellation,
        )
        .await?;
    assert_eq!(
        serde_json::to_value(prompt)?["messages"][0]["content"]["text"],
        "Review runtime"
    );

    gateway
        .call_tool(&server_id, "log_secret", Map::new(), &cancellation)
        .await?;
    let event = gateway.next_event(&server_id, &cancellation).await?;
    let McpEvent::Logging { data, .. } = event else {
        return Err("expected a logging event".into());
    };
    let serialized_log = serde_json::to_string(&data)?;
    assert!(!serialized_log.contains("production-gateway-secret"));
    assert!(serialized_log.contains("REDACTED"));

    let report = gateway.disconnect(&server_id, &cancellation).await?;
    assert_eq!(report.stderr.map(|summary| summary.total_bytes), Some(0));
    assert!(matches!(
        gateway.connection_info(&server_id).await,
        Err(McpError::NotConnected { .. })
    ));
    Ok(())
}

#[tokio::test]
async fn production_stdio_gateway_bounds_handshake_and_failure_cleanup() -> TestResult {
    let gateway = McpGateway::with_config(
        McpTimeouts::new(
            Duration::from_millis(150),
            Duration::from_secs(2),
            Duration::from_secs(2),
        )?,
        McpGatewayLimits::default(),
    );
    let cancellation = CancellationToken::new();
    let error = gateway
        .connect_stdio(
            McpServerId::new("hanging-fixture")?,
            stdio_config("mcp-stdio-hang.cjs")?,
            &cancellation,
        )
        .await
        .expect_err("hanging handshake must time out");

    assert!(matches!(error, McpError::Timeout { .. }));

    let failure = gateway
        .connect_stdio(
            McpServerId::new("failing-fixture")?,
            stdio_config("mcp-stdio-failure.cjs")?.with_output_limits(1024, 512)?,
            &cancellation,
        )
        .await
        .expect_err("failing server must not initialize");
    assert!(matches!(failure, McpError::Protocol { .. }));
    Ok(())
}

#[tokio::test]
async fn production_http_gateway_supports_subscriptions_without_broad_404_recovery() -> TestResult {
    let (mut fixture_process, endpoint) = start_http_fixture().await?;
    let gateway = test_gateway();
    let server_id = McpServerId::new("http-fixture")?;
    let cancellation = CancellationToken::new();
    let info = gateway
        .connect_streamable_http(
            server_id.clone(),
            StreamableHttpServerConfig::new(&endpoint, BTreeMap::new())?,
            &cancellation,
        )
        .await?;
    assert_eq!(info.server.server_info.name, "codez-rmcp-http-spike");

    let catalog = gateway.list_catalog(&server_id, &cancellation).await?;
    assert!(catalog.tools.iter().any(|tool| tool.name == "echo"));
    gateway
        .subscribe(&server_id, "test://base", &cancellation)
        .await?;
    gateway
        .call_tool(&server_id, "notify_resource", Map::new(), &cancellation)
        .await?;
    let event = gateway.next_event(&server_id, &cancellation).await?;
    assert!(matches!(
        event,
        McpEvent::ResourceUpdated { ref uri } if uri == "test://base"
    ));
    gateway
        .unsubscribe(&server_id, "test://base", &cancellation)
        .await?;

    gateway
        .call_tool(&server_id, "arm_generic_404", Map::new(), &cancellation)
        .await?;
    let generic_404 = gateway
        .call_tool(
            &server_id,
            "echo",
            arguments(json!({ "message": "must-not-reinitialize" })),
            &cancellation,
        )
        .await
        .expect_err("generic 404 must not trigger session recovery");
    assert!(matches!(generic_404, McpError::Protocol { .. }));

    gateway.disconnect(&server_id, &cancellation).await?;
    fixture_process.kill().await?;
    fixture_process.wait().await?;
    Ok(())
}

#[tokio::test]
async fn production_legacy_sse_gateway_connects_discovers_and_calls_a_local_server() -> TestResult {
    let (mut fixture_process, endpoint) = start_legacy_sse_fixture().await?;
    let gateway = test_gateway();
    let server_id = McpServerId::new("legacy-sse-fixture")?;
    let cancellation = CancellationToken::new();
    let info = gateway
        .connect_legacy_sse(
            server_id.clone(),
            StreamableHttpServerConfig::new(&endpoint, BTreeMap::new())?,
            &cancellation,
        )
        .await?;

    assert_eq!(info.transport, codez_mcp::McpTransportKind::LegacySse);
    let catalog = gateway.list_catalog(&server_id, &cancellation).await?;
    assert!(catalog.tools.iter().any(|tool| tool.name == "echo"));
    let response = gateway
        .call_tool(
            &server_id,
            "echo",
            arguments(json!({ "message": "hello" })),
            &cancellation,
        )
        .await?;
    assert_eq!(result_text(&response), Some("sse:hello"));

    gateway.disconnect(&server_id, &cancellation).await?;
    fixture_process.kill().await?;
    fixture_process.wait().await?;
    Ok(())
}

#[test]
fn test_environment_does_not_depend_on_ambient_secret_values() {
    let environment = explicit_test_environment();
    assert!(!environment.contains_key(OsStr::new("CODEZ_MCP_TEST_TOKEN")));
}
