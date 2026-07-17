use std::{
    collections::HashSet,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use codez_core::{AppError, CancellationToken};
use codez_runtime::tools::{
    registry::{
        BoxFuture, DefaultToolDescriptor, ToolAvailability, ToolBehavior, ToolContext,
        ToolDescriptor, ToolHandler,
    },
    types::{
        ModelPreference, ToolApprovalMetadata, ToolConcurrency, ToolEffect, ToolEffectPlan,
        ToolExecutionError, ToolExecutionResult, ToolExposure, ToolInterruptBehavior,
        ToolPlanningContext, ToolSource,
    },
};
use codez_storage::AtomicFileStore;
use dom_smoothie::{Config as ReadabilityConfig, Readability, TextMode};
use encoding_rs::Encoding;
use futures_util::{StreamExt, future::join_all};
use reqwest::{
    StatusCode,
    header::{ACCEPT, ACCEPT_LANGUAGE, CONTENT_LENGTH, CONTENT_TYPE, LOCATION, USER_AGENT},
    redirect::Policy,
};
use scraper::{ElementRef, Html, Selector};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::{Host, Url};

const MAX_REDIRECTS: usize = 5;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_FETCH_OUTPUT_CHARS: usize = 40_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const DEFAULT_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 CodeZ/0.1";

#[derive(Debug, Clone)]
struct WebFailure {
    code: &'static str,
    message: String,
    recoverable: bool,
}

impl WebFailure {
    fn new(code: &'static str, message: impl Into<String>, recoverable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            recoverable,
        }
    }

    fn into_tool_error(self) -> ToolExecutionError {
        ToolExecutionError {
            code: self.code.to_string(),
            message: self.message,
            recoverable: self.recoverable,
            suggestion: None,
            retry_after_ms: None,
            details: None,
        }
    }
}

#[derive(Debug, Clone)]
struct SafeHttpResponse {
    status: StatusCode,
    final_url: Url,
    content_type: Option<String>,
    location: Option<String>,
    body: Vec<u8>,
}

#[async_trait::async_trait]
trait DnsResolver: Send + Sync {
    async fn resolve(
        &self,
        host: &str,
        port: u16,
        cancellation: &CancellationToken,
    ) -> Result<Vec<SocketAddr>, WebFailure>;
}

struct TokioDnsResolver;

#[async_trait::async_trait]
impl DnsResolver for TokioDnsResolver {
    async fn resolve(
        &self,
        host: &str,
        port: u16,
        cancellation: &CancellationToken,
    ) -> Result<Vec<SocketAddr>, WebFailure> {
        let lookup = tokio::net::lookup_host((host, port));
        let addresses = tokio::select! {
            () = cancellation.cancelled() => {
                return Err(WebFailure::new("TOOL_CANCELLED", "Web request was cancelled.", true));
            }
            result = lookup => result.map_err(|error| {
                WebFailure::new("WEB_DNS_FAILED", format!("DNS resolution failed: {error}"), true)
            })?,
        };
        let mut unique = HashSet::new();
        Ok(addresses
            .filter(|address| unique.insert(*address))
            .collect())
    }
}

#[async_trait::async_trait]
trait HttpTransport: Send + Sync {
    async fn get(
        &self,
        url: &Url,
        addresses: &[SocketAddr],
        accept: &str,
        cancellation: &CancellationToken,
    ) -> Result<SafeHttpResponse, WebFailure>;
}

struct ReqwestTransport;

#[async_trait::async_trait]
impl HttpTransport for ReqwestTransport {
    async fn get(
        &self,
        url: &Url,
        addresses: &[SocketAddr],
        accept: &str,
        cancellation: &CancellationToken,
    ) -> Result<SafeHttpResponse, WebFailure> {
        let host = url
            .host_str()
            .ok_or_else(|| WebFailure::new("WEB_URL_INVALID", "URL host is required.", false))?;
        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .resolve_to_addrs(host, addresses)
            .build()
            .map_err(|error| {
                WebFailure::new(
                    "WEB_CLIENT_FAILED",
                    format!("HTTP client initialization failed: {error}"),
                    false,
                )
            })?;
        let request = client
            .get(url.clone())
            .header(USER_AGENT, DEFAULT_USER_AGENT)
            .header(ACCEPT, accept)
            .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8");
        let response = tokio::select! {
            () = cancellation.cancelled() => {
                return Err(WebFailure::new("TOOL_CANCELLED", "Web request was cancelled.", true));
            }
            result = request.send() => result.map_err(|error| {
                WebFailure::new("WEB_REQUEST_FAILED", format!("HTTP request failed: {error}"), true)
            })?,
        };
        let status = response.status();
        let final_url = response.url().clone();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        if is_redirect(status) {
            return Ok(SafeHttpResponse {
                status,
                final_url,
                content_type,
                location,
                body: Vec::new(),
            });
        }
        if response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(WebFailure::new(
                "WEB_BODY_TOO_LARGE",
                "HTTP response exceeds the decompressed body limit.",
                false,
            ));
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        loop {
            let chunk = tokio::select! {
                () = cancellation.cancelled() => {
                    return Err(WebFailure::new("TOOL_CANCELLED", "Web request was cancelled.", true));
                }
                chunk = stream.next() => chunk,
            };
            let Some(chunk) = chunk else {
                break;
            };
            let chunk = chunk.map_err(|error| {
                WebFailure::new(
                    "WEB_BODY_READ_FAILED",
                    format!("HTTP response body failed: {error}"),
                    true,
                )
            })?;
            let next_len = body.len().checked_add(chunk.len()).ok_or_else(|| {
                WebFailure::new(
                    "WEB_BODY_TOO_LARGE",
                    "HTTP response exceeds the decompressed body limit.",
                    false,
                )
            })?;
            if next_len > MAX_RESPONSE_BYTES {
                return Err(WebFailure::new(
                    "WEB_BODY_TOO_LARGE",
                    "HTTP response exceeds the decompressed body limit.",
                    false,
                ));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(SafeHttpResponse {
            status,
            final_url,
            content_type,
            location,
            body,
        })
    }
}

struct SecureWebClient {
    resolver: Arc<dyn DnsResolver>,
    transport: Arc<dyn HttpTransport>,
}

impl SecureWebClient {
    fn production() -> Self {
        Self {
            resolver: Arc::new(TokioDnsResolver),
            transport: Arc::new(ReqwestTransport),
        }
    }

    async fn get(
        &self,
        url: Url,
        accept: &str,
        cancellation: &CancellationToken,
    ) -> Result<SafeHttpResponse, WebFailure> {
        let mut current = url;
        for hop in 0..=MAX_REDIRECTS {
            let addresses = self.validate_and_resolve(&current, cancellation).await?;
            let response = self
                .transport
                .get(&current, &addresses, accept, cancellation)
                .await?;
            if response.body.len() > MAX_RESPONSE_BYTES {
                return Err(WebFailure::new(
                    "WEB_BODY_TOO_LARGE",
                    "HTTP response exceeds the decompressed body limit.",
                    false,
                ));
            }
            if !is_redirect(response.status) {
                return Ok(response);
            }
            if hop == MAX_REDIRECTS {
                return Err(WebFailure::new(
                    "WEB_TOO_MANY_REDIRECTS",
                    "HTTP redirect limit exceeded.",
                    false,
                ));
            }
            let location = response.location.as_deref().ok_or_else(|| {
                WebFailure::new(
                    "WEB_REDIRECT_INVALID",
                    "HTTP redirect is missing a Location header.",
                    false,
                )
            })?;
            current = current.join(location).map_err(|error| {
                WebFailure::new(
                    "WEB_REDIRECT_INVALID",
                    format!("HTTP redirect URL is invalid: {error}"),
                    false,
                )
            })?;
        }
        Err(WebFailure::new(
            "WEB_TOO_MANY_REDIRECTS",
            "HTTP redirect limit exceeded.",
            false,
        ))
    }

    async fn validate_and_resolve(
        &self,
        url: &Url,
        cancellation: &CancellationToken,
    ) -> Result<Vec<SocketAddr>, WebFailure> {
        if !matches!(url.scheme(), "http" | "https") {
            return Err(WebFailure::new(
                "WEB_SCHEME_DENIED",
                "Only HTTP and HTTPS URLs are allowed.",
                false,
            ));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(WebFailure::new(
                "WEB_URL_CREDENTIALS_DENIED",
                "URLs containing credentials are not allowed.",
                false,
            ));
        }
        let port = url.port_or_known_default().ok_or_else(|| {
            WebFailure::new(
                "WEB_URL_INVALID",
                "URL port could not be determined.",
                false,
            )
        })?;
        match url.host() {
            Some(Host::Ipv4(address)) => {
                validate_addresses(vec![SocketAddr::new(IpAddr::V4(address), port)])
            }
            Some(Host::Ipv6(address)) => {
                validate_addresses(vec![SocketAddr::new(IpAddr::V6(address), port)])
            }
            Some(Host::Domain(host)) => {
                let normalized = host.trim_end_matches('.').to_ascii_lowercase();
                if metadata_host(&normalized) {
                    return Err(WebFailure::new(
                        "WEB_METADATA_ENDPOINT_DENIED",
                        "Cloud metadata endpoints are not allowed.",
                        false,
                    ));
                }
                let addresses = self
                    .resolver
                    .resolve(&normalized, port, cancellation)
                    .await?;
                validate_addresses(addresses)
            }
            None => Err(WebFailure::new(
                "WEB_URL_INVALID",
                "URL host is required.",
                false,
            )),
        }
    }
}

fn validate_addresses(addresses: Vec<SocketAddr>) -> Result<Vec<SocketAddr>, WebFailure> {
    if addresses.is_empty() {
        return Err(WebFailure::new(
            "WEB_DNS_EMPTY",
            "DNS resolution returned no addresses.",
            true,
        ));
    }
    if addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(WebFailure::new(
            "WEB_SSRF_DENIED",
            "The target resolves to a non-public network address.",
            false,
        ));
    }
    Ok(addresses)
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    !(address.is_unspecified()
        || address.is_loopback()
        || address.is_private()
        || address.is_link_local()
        || address.is_multicast()
        || address.is_broadcast()
        || octets[0] == 0
        || octets[0] >= 224
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
        || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
        || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
        || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113))
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return is_public_ipv4(mapped);
    }
    let segments = address.segments();
    !(address.is_unspecified()
        || address.is_loopback()
        || address.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] & 0xffc0) == 0xfec0
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

fn metadata_host(host: &str) -> bool {
    matches!(
        host,
        "metadata.google.internal" | "metadata.azure.internal" | "instance-data" | "metadata"
    )
}

fn is_redirect(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::SEE_OTHER
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    )
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettingsDocument {
    #[serde(default)]
    web_search: WebSearchSettings,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebSearchSettings {
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    engines: WebSearchEngines,
    #[serde(default)]
    blocked_domains: Vec<String>,
    #[serde(default = "default_max_results")]
    max_results: usize,
}

impl Default for WebSearchSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            engines: WebSearchEngines::default(),
            blocked_domains: Vec::new(),
            max_results: default_max_results(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct WebSearchEngines {
    #[serde(default = "default_true")]
    baidu: bool,
    #[serde(default = "default_true")]
    juejin: bool,
    #[serde(default = "default_true")]
    csdn: bool,
}

impl Default for WebSearchEngines {
    fn default() -> Self {
        Self {
            baidu: true,
            juejin: true,
            csdn: true,
        }
    }
}

const fn default_true() -> bool {
    true
}

const fn default_max_results() -> usize {
    10
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WebSearchResult {
    title: String,
    url: String,
    snippet: String,
    source: String,
    engine: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineFailure {
    engine: String,
    reason: String,
}

#[derive(Debug, Clone, Copy)]
enum WebToolKind {
    Search,
    Fetch,
}

struct WebToolDefinition {
    kind: WebToolKind,
    name: &'static str,
    summary: &'static str,
    description: &'static str,
    input_schema: Value,
}

pub(crate) struct WebTool {
    descriptor: DefaultToolDescriptor,
    kind: WebToolKind,
    data_root: std::path::PathBuf,
    storage: Arc<AtomicFileStore>,
    client: Arc<SecureWebClient>,
}

impl WebTool {
    pub(crate) fn search(
        data_root: impl Into<std::path::PathBuf>,
        storage: Arc<AtomicFileStore>,
    ) -> Self {
        Self::new(
            WebToolDefinition {
                kind: WebToolKind::Search,
                name: "WebSearch",
                summary: "Search the web for current information.",
                description: "Search enabled web engines and return titles, public URLs, and snippets. Domain filters use exact hosts or dot-boundary subdomains.",
                input_schema: search_schema(),
            },
            data_root,
            storage,
            Arc::new(SecureWebClient::production()),
        )
    }

    pub(crate) fn fetch(
        data_root: impl Into<std::path::PathBuf>,
        storage: Arc<AtomicFileStore>,
    ) -> Self {
        Self::new(
            WebToolDefinition {
                kind: WebToolKind::Fetch,
                name: "WebFetch",
                summary: "Fetch and process content from a URL.",
                description: "Fetch one public HTTP/HTTPS URL, revalidate every redirect, extract the main content, and return bounded Markdown. JavaScript-rendered content may be incomplete.",
                input_schema: fetch_schema(),
            },
            data_root,
            storage,
            Arc::new(SecureWebClient::production()),
        )
    }

    fn new(
        definition: WebToolDefinition,
        data_root: impl Into<std::path::PathBuf>,
        storage: Arc<AtomicFileStore>,
        client: Arc<SecureWebClient>,
    ) -> Self {
        let WebToolDefinition {
            kind,
            name,
            summary,
            description,
            input_schema,
        } = definition;
        Self {
            descriptor: DefaultToolDescriptor {
                name,
                version: "1.0.0",
                source: ToolSource::Builtin,
                source_id: format!("builtin:{}", name.to_ascii_lowercase()),
                summary: summary.to_string(),
                description: description.to_string(),
                input_schema,
                approval: ToolApprovalMetadata {
                    model_preference: ModelPreference::NotApplicable,
                },
                availability: ToolAvailability {
                    roles: None,
                    platforms: None,
                    exposure: ToolExposure::Deferred,
                },
                behavior: ToolBehavior {
                    concurrency: ToolConcurrency::Safe,
                    interrupt: ToolInterruptBehavior::Cancel,
                    max_result_chars: 128 * 1024,
                    timeout_ms: Some(30_000),
                },
            },
            kind,
            data_root: data_root.into(),
            storage,
            client,
        }
    }

    async fn load_settings(&self) -> Result<WebSearchSettings, WebFailure> {
        self.storage
            .read_json::<AppSettingsDocument>(&self.data_root.join("settings.json"))
            .await
            .map(|document| {
                document.unwrap_or_else(|| AppSettingsDocument {
                    web_search: WebSearchSettings::default(),
                })
            })
            .map(|document| document.web_search)
            .map_err(|error| {
                WebFailure::new(
                    "WEB_SETTINGS_FAILED",
                    AppError::from(error).public_message(),
                    false,
                )
            })
    }

    async fn run_search(
        &self,
        input: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, WebFailure> {
        let query = required_string(input, "query")?;
        let settings = self.load_settings().await?;
        if !settings.enabled {
            return Err(WebFailure::new(
                "WEB_SEARCH_DISABLED",
                "Web search is disabled in settings.",
                false,
            ));
        }
        let limit = settings.max_results.clamp(1, 20);
        let allowed = parse_domain_filters(input.get("allowed_domains"))?;
        let mut blocked = parse_domain_filters(input.get("blocked_domains"))?;
        blocked.extend(parse_domain_strings(&settings.blocked_domains)?);
        let per_engine_limit = limit.max(10);
        let mut jobs = Vec::new();
        if settings.engines.baidu {
            jobs.push(self.search_engine("baidu", query, per_engine_limit, cancellation));
        }
        if settings.engines.juejin {
            jobs.push(self.search_engine("juejin", query, per_engine_limit, cancellation));
        }
        if settings.engines.csdn {
            jobs.push(self.search_engine("csdn", query, per_engine_limit, cancellation));
        }
        if jobs.is_empty() {
            return Err(WebFailure::new(
                "WEB_SEARCH_NO_ENGINE",
                "No web search engine is enabled.",
                false,
            ));
        }
        let outcomes = join_all(jobs).await;
        let mut results = Vec::new();
        let mut failures = Vec::new();
        let mut used_engines = Vec::new();
        for (engine, outcome) in outcomes {
            used_engines.push(engine.to_string());
            match outcome {
                Ok(engine_results) => results.extend(engine_results),
                Err(error) => failures.push(EngineFailure {
                    engine: engine.to_string(),
                    reason: error.message,
                }),
            }
        }
        let mut seen = HashSet::new();
        results.retain(|result| {
            let Ok(url) = Url::parse(&result.url) else {
                return false;
            };
            let Some(host) = url.host_str().map(|host| host.to_ascii_lowercase()) else {
                return false;
            };
            if !allowed.is_empty() && !allowed.iter().any(|domain| domain_matches(&host, domain)) {
                return false;
            }
            if blocked.iter().any(|domain| domain_matches(&host, domain)) {
                return false;
            }
            let key = format!(
                "{}{}",
                host,
                url.path().trim_end_matches('/').to_ascii_lowercase()
            );
            seen.insert(key)
        });
        results.truncate(limit);
        Ok(serde_json::json!({
            "query": query,
            "results": results,
            "partialFailures": failures,
            "usedEngines": used_engines,
        }))
    }

    async fn search_engine<'a>(
        &'a self,
        engine: &'static str,
        query: &'a str,
        limit: usize,
        cancellation: &'a CancellationToken,
    ) -> (&'static str, Result<Vec<WebSearchResult>, WebFailure>) {
        let outcome = async {
            let url = search_url(engine, query, limit)?;
            let response = self
                .client
                .get(url, search_accept(engine), cancellation)
                .await?;
            ensure_success(&response)?;
            ensure_search_content_type(engine, response.content_type.as_deref())?;
            let body = decode_body(&response.body, response.content_type.as_deref())?;
            match engine {
                "baidu" => parse_baidu_html(&body, limit),
                "juejin" => parse_juejin_json(&body, limit),
                "csdn" => parse_csdn_json(&body, limit),
                _ => Ok(Vec::new()),
            }
        }
        .await;
        (engine, outcome)
    }

    async fn run_fetch(
        &self,
        input: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, WebFailure> {
        let raw_url = required_string(input, "url")?;
        let url = Url::parse(raw_url).map_err(|error| {
            WebFailure::new("WEB_URL_INVALID", format!("URL is invalid: {error}"), false)
        })?;
        let response = self
            .client
            .get(
                url,
                "text/html,application/xhtml+xml,text/plain;q=0.9",
                cancellation,
            )
            .await?;
        ensure_success(&response)?;
        ensure_fetch_content_type(response.content_type.as_deref())?;
        let body = decode_body(&response.body, response.content_type.as_deref())?;
        let final_url = response.final_url.to_string();
        let content_type = response.content_type.unwrap_or_default();
        let (title, markdown) = if content_type.to_ascii_lowercase().starts_with("text/plain") {
            (String::new(), body)
        } else {
            extract_article(body, final_url.clone()).await?
        };
        let (markdown, truncated) = truncate_chars(&markdown, MAX_FETCH_OUTPUT_CHARS);
        Ok(serde_json::json!({
            "url": final_url,
            "title": title,
            "markdown": if markdown.is_empty() { "(No readable content extracted)" } else { &markdown },
            "truncated": truncated,
            "prompt": input.get("prompt").and_then(Value::as_str),
        }))
    }
}

impl ToolHandler for WebTool {
    fn descriptor(&self) -> &dyn ToolDescriptor {
        &self.descriptor
    }

    fn plan_effects<'a>(
        &'a self,
        input: &'a Value,
        _context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, ToolEffectPlan> {
        Box::pin(async move {
            let target = match self.kind {
                WebToolKind::Search => input
                    .get("query")
                    .and_then(Value::as_str)
                    .map(|query| format!("search:{query}")),
                WebToolKind::Fetch => input.get("url").and_then(Value::as_str).map(str::to_string),
            };
            ToolEffectPlan {
                effects: vec![ToolEffect::Network {
                    target,
                    method: Some("GET".to_string()),
                }],
                analysis_status: "parsed".to_string(),
            }
        })
    }

    fn resource_keys<'a>(
        &'a self,
        input: &'a Value,
        _context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move {
            let target = match self.kind {
                WebToolKind::Search => input
                    .get("query")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown"),
                WebToolKind::Fetch => input
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown"),
            };
            vec![format!("network:{target}")]
        })
    }

    fn execute<'a>(
        &'a self,
        input: &'a Value,
        context: &'a ToolContext,
    ) -> BoxFuture<'a, ToolExecutionResult> {
        Box::pin(async move {
            let result = match self.kind {
                WebToolKind::Search => self.run_search(input, &context.cancellation).await,
                WebToolKind::Fetch => self.run_fetch(input, &context.cancellation).await,
            };
            match result {
                Ok(data) => ToolExecutionResult::Success {
                    model_content: data.to_string(),
                    data: Some(data),
                    ui_content: None,
                    effects: None,
                },
                Err(error) if error.code == "TOOL_CANCELLED" => ToolExecutionResult::Cancelled {
                    error: error.into_tool_error(),
                    model_content: None,
                    ui_content: None,
                    effects: None,
                },
                Err(error) => ToolExecutionResult::Error {
                    error: error.into_tool_error(),
                    model_content: None,
                    ui_content: None,
                    effects: None,
                },
            }
        })
    }
}

fn search_url(engine: &str, query: &str, limit: usize) -> Result<Url, WebFailure> {
    let encoded = url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>();
    let raw = match engine {
        "baidu" => format!(
            "https://www.baidu.com/s?wd={encoded}&rn={}",
            (limit * 2).min(50)
        ),
        "juejin" => format!(
            "https://api.juejin.cn/search_api/v1/search?query={encoded}&id_type=0&cursor=0&limit={}&search_type=0&sort_type=0&aid=2608&uuid=0",
            (limit * 2).min(40)
        ),
        _ => format!(
            "https://so.csdn.net/api/v3/search?q={encoded}&t=all&p=1&size={}",
            (limit * 2).min(30)
        ),
    };
    Url::parse(&raw).map_err(|error| {
        WebFailure::new(
            "WEB_SEARCH_URL_INVALID",
            format!("Search engine URL could not be constructed: {error}"),
            false,
        )
    })
}

fn search_accept(engine: &str) -> &'static str {
    if engine == "baidu" {
        "text/html,application/xhtml+xml"
    } else {
        "application/json,text/plain;q=0.9"
    }
}

fn ensure_success(response: &SafeHttpResponse) -> Result<(), WebFailure> {
    if response.status.is_success() {
        Ok(())
    } else {
        Err(WebFailure::new(
            "WEB_HTTP_STATUS",
            format!("HTTP request returned status {}.", response.status),
            response.status.is_server_error(),
        ))
    }
}

fn ensure_fetch_content_type(content_type: Option<&str>) -> Result<(), WebFailure> {
    let Some(content_type) = content_type else {
        return Ok(());
    };
    let content_type = content_type.to_ascii_lowercase();
    if content_type.starts_with("text/html")
        || content_type.starts_with("application/xhtml+xml")
        || content_type.starts_with("text/plain")
    {
        Ok(())
    } else {
        Err(WebFailure::new(
            "WEB_CONTENT_TYPE_DENIED",
            format!("Unsupported content type: {content_type}"),
            false,
        ))
    }
}

fn ensure_search_content_type(engine: &str, content_type: Option<&str>) -> Result<(), WebFailure> {
    if engine == "baidu" {
        ensure_fetch_content_type(content_type)
    } else if content_type.is_none_or(|value| {
        let value = value.to_ascii_lowercase();
        value.starts_with("application/json") || value.starts_with("text/plain")
    }) {
        Ok(())
    } else {
        Err(WebFailure::new(
            "WEB_CONTENT_TYPE_DENIED",
            "Search engine returned an unsupported content type.",
            false,
        ))
    }
}

fn decode_body(bytes: &[u8], content_type: Option<&str>) -> Result<String, WebFailure> {
    let charset = content_type.and_then(|value| {
        value.split(';').skip(1).find_map(|parameter| {
            let (name, value) = parameter.trim().split_once('=')?;
            name.eq_ignore_ascii_case("charset")
                .then(|| value.trim_matches(['"', '\'']).as_bytes())
        })
    });
    let encoding = match charset {
        Some(label) => Encoding::for_label(label).ok_or_else(|| {
            WebFailure::new(
                "WEB_CHARSET_UNSUPPORTED",
                "HTTP response declares an unsupported charset.",
                false,
            )
        })?,
        None => encoding_rs::UTF_8,
    };
    let (decoded, _, had_errors) = encoding.decode(bytes);
    if had_errors {
        return Err(WebFailure::new(
            "WEB_CHARSET_INVALID",
            "HTTP response is not valid in its declared charset.",
            false,
        ));
    }
    Ok(decoded.into_owned())
}

async fn extract_article(html: String, url: String) -> Result<(String, String), WebFailure> {
    tokio::task::spawn_blocking(move || {
        let config = ReadabilityConfig {
            max_elements_to_parse: 50_000,
            text_mode: TextMode::Markdown,
            ..ReadabilityConfig::default()
        };
        match Readability::new(html.clone(), Some(&url), Some(config))
            .and_then(|mut value| value.parse())
        {
            Ok(article) => Ok((article.title, article.text_content.to_string())),
            Err(_) => fallback_html_text(&html),
        }
    })
    .await
    .map_err(|error| {
        WebFailure::new(
            "WEB_PARSE_TASK_FAILED",
            format!("Article extraction worker failed: {error}"),
            false,
        )
    })?
}

fn fallback_html_text(html: &str) -> Result<(String, String), WebFailure> {
    let document = Html::parse_document(html);
    let title_selector = selector("title")?;
    let body_selector = selector("body")?;
    let title = document
        .select(&title_selector)
        .next()
        .map(element_text)
        .unwrap_or_default();
    let markdown = document
        .select(&body_selector)
        .next()
        .map(element_text)
        .unwrap_or_default();
    Ok((title, markdown))
}

fn parse_baidu_html(html: &str, limit: usize) -> Result<Vec<WebSearchResult>, WebFailure> {
    let document = Html::parse_document(html);
    let result_selector = selector("div.result")?;
    let link_selector = selector("h3 a")?;
    let snippet_selector = selector(".c-abstract, .content-right")?;
    let mut results = Vec::new();
    for block in document.select(&result_selector) {
        let Some(link) = block.select(&link_selector).next() else {
            continue;
        };
        let Some(url) = link.value().attr("href") else {
            continue;
        };
        let title = element_text(link);
        if title.is_empty() || Url::parse(url).is_err() {
            continue;
        }
        let snippet = block
            .select(&snippet_selector)
            .next()
            .map(element_text)
            .unwrap_or_default();
        results.push(WebSearchResult {
            title,
            url: url.to_string(),
            snippet,
            source: "Baidu".to_string(),
            engine: "baidu".to_string(),
        });
        if results.len() >= limit {
            break;
        }
    }
    Ok(results)
}

fn parse_juejin_json(body: &str, limit: usize) -> Result<Vec<WebSearchResult>, WebFailure> {
    let value: Value = serde_json::from_str(body).map_err(|error| {
        WebFailure::new(
            "WEB_SEARCH_PARSE_FAILED",
            format!("Juejin returned invalid JSON: {error}"),
            false,
        )
    })?;
    let Some(items) = value.get("data").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    Ok(items
        .iter()
        .filter_map(|item| {
            let model = item.get("result_model").unwrap_or(item);
            let info = model
                .get("article_info")
                .or_else(|| model.get("info"))
                .unwrap_or(model);
            let title = value_string(info, &["title", "article_title"])?;
            let id = value_string(info, &["article_id", "id"]);
            let url = id
                .map(|id| format!("https://juejin.cn/post/{id}"))
                .or_else(|| value_string(info, &["url"]))?;
            Some(WebSearchResult {
                title,
                url,
                snippet: value_string(info, &["brief_content", "content", "summary"])
                    .unwrap_or_default(),
                source: "Juejin".to_string(),
                engine: "juejin".to_string(),
            })
        })
        .take(limit)
        .collect())
}

fn parse_csdn_json(body: &str, limit: usize) -> Result<Vec<WebSearchResult>, WebFailure> {
    let value: Value = serde_json::from_str(body).map_err(|error| {
        WebFailure::new(
            "WEB_SEARCH_PARSE_FAILED",
            format!("CSDN returned invalid JSON: {error}"),
            false,
        )
    })?;
    let items = value
        .get("result_vos")
        .or_else(|| value.pointer("/data/items"))
        .or_else(|| value.get("items"))
        .and_then(Value::as_array);
    let Some(items) = items else {
        return Ok(Vec::new());
    };
    let tag_selector = selector("body")?;
    Ok(items
        .iter()
        .filter_map(|item| {
            let title = strip_html(value_string(item, &["title", "name"])?, &tag_selector);
            let url = value_string(item, &["url", "link"])?;
            if title.is_empty() || Url::parse(&url).is_err() {
                return None;
            }
            let snippet = value_string(item, &["description", "desc", "summary", "content"])
                .map(|value| strip_html(value, &tag_selector))
                .unwrap_or_default();
            Some(WebSearchResult {
                title,
                url,
                snippet,
                source: "CSDN".to_string(),
                engine: "csdn".to_string(),
            })
        })
        .take(limit)
        .collect())
}

fn value_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn strip_html(value: String, body_selector: &Selector) -> String {
    let fragment = Html::parse_document(&format!("<body>{value}</body>"));
    fragment
        .select(body_selector)
        .next()
        .map(element_text)
        .unwrap_or_default()
}

fn selector(value: &str) -> Result<Selector, WebFailure> {
    Selector::parse(value).map_err(|error| {
        WebFailure::new(
            "WEB_PARSER_INVALID",
            format!("HTML selector could not be compiled: {error}"),
            false,
        )
    })
}

fn element_text(element: ElementRef<'_>) -> String {
    element
        .text()
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_domain_filters(value: Option<&Value>) -> Result<Vec<String>, WebFailure> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let values = value.as_array().ok_or_else(|| {
        WebFailure::new(
            "WEB_DOMAIN_FILTER_INVALID",
            "Domain filters must be an array.",
            false,
        )
    })?;
    let strings = values
        .iter()
        .map(|value| {
            value.as_str().map(str::to_string).ok_or_else(|| {
                WebFailure::new(
                    "WEB_DOMAIN_FILTER_INVALID",
                    "Every domain filter must be a string.",
                    false,
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    parse_domain_strings(&strings)
}

fn parse_domain_strings(values: &[String]) -> Result<Vec<String>, WebFailure> {
    values
        .iter()
        .map(|value| {
            let domain = value
                .trim()
                .trim_start_matches("*.")
                .trim_end_matches('.')
                .to_ascii_lowercase();
            if domain.is_empty()
                || domain.len() > 253
                || domain.contains(['/', ':', '@'])
                || domain.split('.').any(|label| {
                    label.is_empty()
                        || label.len() > 63
                        || label.starts_with('-')
                        || label.ends_with('-')
                        || !label
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                })
            {
                return Err(WebFailure::new(
                    "WEB_DOMAIN_FILTER_INVALID",
                    format!("Invalid domain filter: {value}"),
                    false,
                ));
            }
            Ok(domain)
        })
        .collect()
}

fn domain_matches(host: &str, domain: &str) -> bool {
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

fn required_string<'a>(input: &'a Value, field: &str) -> Result<&'a str, WebFailure> {
    input
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            WebFailure::new("TOOL_INPUT_INVALID", format!("{field} is required."), false)
        })
}

fn truncate_chars(value: &str, max_chars: usize) -> (String, bool) {
    let Some((byte_index, _)) = value.char_indices().nth(max_chars) else {
        return (value.to_string(), false);
    };
    (value[..byte_index].to_string(), true)
}

fn search_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "query": { "type": "string", "minLength": 1, "maxLength": 1024 },
            "allowed_domains": {
                "type": "array", "maxItems": 20,
                "items": { "type": "string", "minLength": 1, "maxLength": 253 }
            },
            "blocked_domains": {
                "type": "array", "maxItems": 20,
                "items": { "type": "string", "minLength": 1, "maxLength": 253 }
            }
        },
        "required": ["query"]
    })
}

fn fetch_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "url": { "type": "string", "minLength": 1, "maxLength": 8192 },
            "prompt": { "type": "string", "maxLength": 4096 }
        },
        "required": ["url"]
    })
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, sync::Mutex};

    use super::*;

    struct StaticResolver {
        addresses: Vec<SocketAddr>,
    }

    #[async_trait::async_trait]
    impl DnsResolver for StaticResolver {
        async fn resolve(
            &self,
            _host: &str,
            _port: u16,
            _cancellation: &CancellationToken,
        ) -> Result<Vec<SocketAddr>, WebFailure> {
            Ok(self.addresses.clone())
        }
    }

    struct QueueTransport {
        responses: Mutex<VecDeque<SafeHttpResponse>>,
    }

    #[async_trait::async_trait]
    impl HttpTransport for QueueTransport {
        async fn get(
            &self,
            _url: &Url,
            _addresses: &[SocketAddr],
            _accept: &str,
            _cancellation: &CancellationToken,
        ) -> Result<SafeHttpResponse, WebFailure> {
            self.responses
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .pop_front()
                .ok_or_else(|| WebFailure::new("TEST_EMPTY", "No fixture response", false))
        }
    }

    fn response(
        status: StatusCode,
        url: &str,
        location: Option<&str>,
        body: Vec<u8>,
    ) -> SafeHttpResponse {
        SafeHttpResponse {
            status,
            final_url: Url::parse(url).expect("fixture URL must parse"),
            content_type: Some("text/html; charset=utf-8".to_string()),
            location: location.map(str::to_string),
            body,
        }
    }

    #[test]
    fn ssrf_policy_rejects_private_link_local_and_mapped_addresses() {
        let denied = [
            "127.0.0.1".parse::<IpAddr>().expect("IP must parse"),
            "169.254.169.254".parse::<IpAddr>().expect("IP must parse"),
            "10.0.0.1".parse::<IpAddr>().expect("IP must parse"),
            "::ffff:127.0.0.1".parse::<IpAddr>().expect("IP must parse"),
        ];
        assert!(denied.into_iter().all(|address| !is_public_ip(address)));
    }

    #[tokio::test]
    async fn redirect_to_loopback_is_rejected_before_the_second_request() {
        let client = SecureWebClient {
            resolver: Arc::new(StaticResolver {
                addresses: vec![
                    "93.184.216.34:443"
                        .parse()
                        .expect("fixture address must parse"),
                ],
            }),
            transport: Arc::new(QueueTransport {
                responses: Mutex::new(VecDeque::from([response(
                    StatusCode::FOUND,
                    "https://example.com/",
                    Some("http://127.0.0.1/private"),
                    Vec::new(),
                )])),
            }),
        };

        let error = client
            .get(
                Url::parse("https://example.com/").expect("fixture URL must parse"),
                "text/html",
                &CancellationToken::new(),
            )
            .await
            .expect_err("loopback redirect must fail");

        assert_eq!(error.code, "WEB_SSRF_DENIED");
    }

    #[tokio::test]
    async fn decompressed_body_limit_is_enforced_for_transport_results() {
        let client = SecureWebClient {
            resolver: Arc::new(StaticResolver {
                addresses: vec![
                    "93.184.216.34:443"
                        .parse()
                        .expect("fixture address must parse"),
                ],
            }),
            transport: Arc::new(QueueTransport {
                responses: Mutex::new(VecDeque::from([response(
                    StatusCode::OK,
                    "https://example.com/",
                    None,
                    vec![b'x'; MAX_RESPONSE_BYTES + 1],
                )])),
            }),
        };

        let error = client
            .get(
                Url::parse("https://example.com/").expect("fixture URL must parse"),
                "text/html",
                &CancellationToken::new(),
            )
            .await
            .expect_err("oversized decompressed body must fail");

        assert_eq!(error.code, "WEB_BODY_TOO_LARGE");
    }

    #[test]
    fn charset_decoder_supports_declared_legacy_text_and_rejects_unknown_labels() {
        let decoded = decode_body(
            &[0x63, 0x61, 0x66, 0xe9],
            Some("text/plain; charset=windows-1252"),
        )
        .expect("declared Windows charset must decode");
        let unsupported = decode_body(b"text", Some("text/plain; charset=not-a-charset"))
            .expect_err("unknown charset must fail");

        assert_eq!(
            (decoded.as_str(), unsupported.code),
            ("caf\u{e9}", "WEB_CHARSET_UNSUPPORTED")
        );
    }

    #[test]
    fn domain_filters_use_dot_boundaries_instead_of_substrings() {
        assert!(domain_matches("docs.example.com", "example.com"));
        assert!(!domain_matches("evil-example.com", "example.com"));
    }

    #[test]
    fn fixture_parsers_preserve_unicode_and_strip_html_highlights() {
        let baidu = parse_baidu_html(
            r#"<div class="result"><h3><a href="https://example.com/zh">中文标题</a></h3><div class="c-abstract">摘要 内容</div></div>"#,
            5,
        )
        .expect("Baidu fixture must parse");
        let csdn = parse_csdn_json(
            r#"{"result_vos":[{"title":"<em>Rust</em> 指南","url":"https://blog.csdn.net/a","description":"安全 <em>测试</em>"}]}"#,
            5,
        )
        .expect("CSDN fixture must parse");

        assert_eq!(
            (baidu[0].title.as_str(), csdn[0].title.as_str()),
            ("中文标题", "Rust 指南")
        );
    }
}
