use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use rmcp::{
    RoleClient, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResult, GetPromptRequestParams, GetPromptResult,
        PaginatedRequestParams, Prompt, ReadResourceRequestParams, ReadResourceResult, Resource,
        ResourceTemplate, ServerInfo, SubscribeRequestParams, Tool, UnsubscribeRequestParams,
    },
    service::{Peer, RunningService, ServiceError},
    transport::{IntoTransport, StreamableHttpClientTransport},
};
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::sync::{Mutex, RwLock, mpsc};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::{
    McpError, McpOperation, McpTransportKind,
    client::{CodezClientHandler, EventRedactor, McpEvent},
    transports::{
        StderrSummary, StdioServerConfig, StreamableHttpServerConfig, sse,
        stdio::{self, StdioResources},
    },
};

const MAX_SERVER_ID_BYTES: usize = 128;

/// Validated key for one configured MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct McpServerId(String);

impl McpServerId {
    pub fn new(value: impl Into<String>) -> Result<Self, McpError> {
        let value = value.into();
        if value.trim().is_empty()
            || value.len() > MAX_SERVER_ID_BYTES
            || value.chars().any(char::is_control)
        {
            return Err(McpError::InvalidServerId {
                max_bytes: MAX_SERVER_ID_BYTES,
            });
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Time budgets applied at all network and process boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct McpTimeouts {
    pub connect: Duration,
    pub request: Duration,
    pub close: Duration,
}

impl McpTimeouts {
    pub fn new(connect: Duration, request: Duration, close: Duration) -> Result<Self, McpError> {
        for (name, value) in [
            ("connect_timeout", connect),
            ("request_timeout", request),
            ("close_timeout", close),
        ] {
            if value.is_zero() {
                return Err(McpError::InvalidLimit { name });
            }
        }
        Ok(Self {
            connect,
            request,
            close,
        })
    }
}

impl Default for McpTimeouts {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(10),
            request: Duration::from_secs(30),
            close: Duration::from_secs(5),
        }
    }
}

/// Memory and pagination limits for an MCP gateway.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct McpGatewayLimits {
    pub event_capacity: usize,
    pub http_channel_capacity: usize,
    pub max_catalog_items: usize,
    pub max_catalog_pages: usize,
}

impl McpGatewayLimits {
    pub fn new(
        event_capacity: usize,
        http_channel_capacity: usize,
        max_catalog_items: usize,
        max_catalog_pages: usize,
    ) -> Result<Self, McpError> {
        for (name, value) in [
            ("event_capacity", event_capacity),
            ("http_channel_capacity", http_channel_capacity),
            ("max_catalog_items", max_catalog_items),
            ("max_catalog_pages", max_catalog_pages),
        ] {
            if value == 0 {
                return Err(McpError::InvalidLimit { name });
            }
        }
        Ok(Self {
            event_capacity,
            http_channel_capacity,
            max_catalog_items,
            max_catalog_pages,
        })
    }
}

impl Default for McpGatewayLimits {
    fn default() -> Self {
        Self {
            event_capacity: 128,
            http_channel_capacity: 32,
            max_catalog_items: 2_000,
            max_catalog_pages: 100,
        }
    }
}

/// Metadata returned after the rmcp initialize handshake completes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectionInfo {
    pub server_id: McpServerId,
    pub transport: McpTransportKind,
    pub server: ServerInfo,
    pub process_id: Option<u32>,
}

/// Fully discovered MCP catalog with bounded pagination.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCatalog {
    pub tools: Vec<Tool>,
    pub resources: Vec<Resource>,
    pub resource_templates: Vec<ResourceTemplate>,
    pub prompts: Vec<Prompt>,
}

/// Non-sensitive shutdown diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct McpDisconnectReport {
    pub stderr: Option<StderrSummary>,
}

type ClientService = RunningService<RoleClient, CodezClientHandler>;

enum ConnectionResources {
    Stdio(StdioResources),
    Http,
}

struct ConnectionEntry {
    id: McpServerId,
    transport: McpTransportKind,
    server_info: ServerInfo,
    peer: Peer<RoleClient>,
    service: Mutex<Option<ClientService>>,
    events: Mutex<mpsc::Receiver<McpEvent>>,
    dropped_events: Arc<AtomicU64>,
    lifetime: CancellationToken,
    resources: ConnectionResources,
    timeouts: McpTimeouts,
}

impl ConnectionEntry {
    fn info(&self) -> McpConnectionInfo {
        let process_id = match &self.resources {
            ConnectionResources::Stdio(resources) => resources.process_id(),
            ConnectionResources::Http => None,
        };
        McpConnectionInfo {
            server_id: self.id.clone(),
            transport: self.transport,
            server: self.server_info.clone(),
            process_id,
        }
    }

    async fn close(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<McpDisconnectReport, McpError> {
        let caller_cancelled = cancellation.is_cancelled();
        self.lifetime.cancel();

        let mut service = self.service.lock().await.take();
        if let Some(service) = service.as_mut() {
            match service.close_with_timeout(self.timeouts.close).await {
                Ok(Some(_reason)) => {}
                Ok(None) => {
                    self.cleanup_resources().await?;
                    return Err(McpError::Timeout {
                        operation: McpOperation::Close,
                        timeout: self.timeouts.close,
                    });
                }
                Err(_join_error) => {
                    self.cleanup_resources().await?;
                    return Err(McpError::BackgroundTask);
                }
            }
        }

        let report = self.cleanup_resources().await?;
        if caller_cancelled {
            return Err(McpError::Cancelled {
                operation: McpOperation::Close,
            });
        }
        Ok(report)
    }

    async fn cleanup_resources(&self) -> Result<McpDisconnectReport, McpError> {
        let stderr = match &self.resources {
            ConnectionResources::Stdio(resources) => {
                Some(resources.cleanup(self.timeouts.close).await?)
            }
            ConnectionResources::Http => None,
        };
        Ok(McpDisconnectReport { stderr })
    }
}

/// Owns live rmcp services, notification queues, and deterministic shutdown.
pub struct McpGateway {
    connections: RwLock<HashMap<McpServerId, Arc<ConnectionEntry>>>,
    root_cancellation: CancellationToken,
    timeouts: McpTimeouts,
    limits: McpGatewayLimits,
}

impl Default for McpGateway {
    fn default() -> Self {
        Self::new()
    }
}

impl McpGateway {
    #[must_use]
    pub fn new() -> Self {
        Self {
            connections: RwLock::new(HashMap::new()),
            root_cancellation: CancellationToken::new(),
            timeouts: McpTimeouts::default(),
            limits: McpGatewayLimits::default(),
        }
    }

    #[must_use]
    pub fn with_config(timeouts: McpTimeouts, limits: McpGatewayLimits) -> Self {
        Self {
            connections: RwLock::new(HashMap::new()),
            root_cancellation: CancellationToken::new(),
            timeouts,
            limits,
        }
    }

    /// Spawns and initializes a direct stdio MCP server.
    pub async fn connect_stdio(
        &self,
        server_id: McpServerId,
        config: StdioServerConfig,
        cancellation: &CancellationToken,
    ) -> Result<McpConnectionInfo, McpError> {
        self.ensure_available(&server_id).await?;
        let redactor = EventRedactor::new(config.redaction_values());
        let lifetime = self.root_cancellation.child_token();
        let (transport, resources) = stdio::spawn(config, self.timeouts.close)?;
        let initialized = self
            .initialize(
                transport,
                McpTransportKind::Stdio,
                redactor,
                lifetime.clone(),
                cancellation,
            )
            .await;
        let (service, events, dropped_events, server_info) = match initialized {
            Ok(initialized) => initialized,
            Err(error) => {
                lifetime.cancel();
                resources.cleanup(self.timeouts.close).await?;
                return Err(error);
            }
        };
        let entry = Arc::new(ConnectionEntry {
            id: server_id.clone(),
            transport: McpTransportKind::Stdio,
            server_info,
            peer: service.peer().clone(),
            service: Mutex::new(Some(service)),
            events: Mutex::new(events),
            dropped_events,
            lifetime,
            resources: ConnectionResources::Stdio(resources),
            timeouts: self.timeouts,
        });
        self.install(server_id, entry.clone(), cancellation).await?;
        Ok(entry.info())
    }

    /// Initializes a Streamable HTTP MCP server with broad HTTP-404 recovery disabled.
    pub async fn connect_streamable_http(
        &self,
        server_id: McpServerId,
        config: StreamableHttpServerConfig,
        cancellation: &CancellationToken,
    ) -> Result<McpConnectionInfo, McpError> {
        self.ensure_available(&server_id).await?;
        let (transport_config, redaction_values) =
            config.into_parts(self.limits.http_channel_capacity);
        let transport = StreamableHttpClientTransport::from_config(transport_config);
        let lifetime = self.root_cancellation.child_token();
        let (service, events, dropped_events, server_info) = self
            .initialize(
                transport,
                McpTransportKind::StreamableHttp,
                EventRedactor::new(redaction_values),
                lifetime.clone(),
                cancellation,
            )
            .await?;
        let entry = Arc::new(ConnectionEntry {
            id: server_id.clone(),
            transport: McpTransportKind::StreamableHttp,
            server_info,
            peer: service.peer().clone(),
            service: Mutex::new(Some(service)),
            events: Mutex::new(events),
            dropped_events,
            lifetime,
            resources: ConnectionResources::Http,
            timeouts: self.timeouts,
        });
        self.install(server_id, entry.clone(), cancellation).await?;
        Ok(entry.info())
    }

    /// Legacy SSE intentionally fails until the ADR-required two-endpoint
    /// transport is implemented and covered by compatibility tests.
    pub fn connect_legacy_sse(&self) -> Result<McpConnectionInfo, McpError> {
        Err(sse::unsupported())
    }

    pub async fn connection_info(
        &self,
        server_id: &McpServerId,
    ) -> Result<McpConnectionInfo, McpError> {
        Ok(self.entry(server_id).await?.info())
    }

    pub async fn list_catalog(
        &self,
        server_id: &McpServerId,
        cancellation: &CancellationToken,
    ) -> Result<McpCatalog, McpError> {
        let entry = self.entry(server_id).await?;
        let tools = self.list_tools(&entry, cancellation).await?;
        let resources = self.list_resources(&entry, cancellation).await?;
        let resource_templates = self.list_resource_templates(&entry, cancellation).await?;
        let prompts = self.list_prompts(&entry, cancellation).await?;
        Ok(McpCatalog {
            tools,
            resources,
            resource_templates,
            prompts,
        })
    }

    pub async fn call_tool(
        &self,
        server_id: &McpServerId,
        name: &str,
        arguments: Map<String, Value>,
        cancellation: &CancellationToken,
    ) -> Result<CallToolResult, McpError> {
        let entry = self.entry(server_id).await?;
        self.request(
            &entry,
            McpOperation::CallTool,
            cancellation,
            entry
                .peer
                .call_tool(CallToolRequestParams::new(name.to_owned()).with_arguments(arguments)),
        )
        .await
    }

    pub async fn read_resource(
        &self,
        server_id: &McpServerId,
        uri: &str,
        cancellation: &CancellationToken,
    ) -> Result<ReadResourceResult, McpError> {
        let entry = self.entry(server_id).await?;
        self.request(
            &entry,
            McpOperation::ReadResource,
            cancellation,
            entry
                .peer
                .read_resource(ReadResourceRequestParams::new(uri.to_owned())),
        )
        .await
    }

    pub async fn get_prompt(
        &self,
        server_id: &McpServerId,
        name: &str,
        arguments: Map<String, Value>,
        cancellation: &CancellationToken,
    ) -> Result<GetPromptResult, McpError> {
        let entry = self.entry(server_id).await?;
        self.request(
            &entry,
            McpOperation::ListPrompts,
            cancellation,
            entry
                .peer
                .get_prompt(GetPromptRequestParams::new(name.to_owned()).with_arguments(arguments)),
        )
        .await
    }

    pub async fn subscribe(
        &self,
        server_id: &McpServerId,
        uri: &str,
        cancellation: &CancellationToken,
    ) -> Result<(), McpError> {
        let entry = self.entry(server_id).await?;
        self.request(
            &entry,
            McpOperation::Subscribe,
            cancellation,
            entry
                .peer
                .subscribe(SubscribeRequestParams::new(uri.to_owned())),
        )
        .await
    }

    pub async fn unsubscribe(
        &self,
        server_id: &McpServerId,
        uri: &str,
        cancellation: &CancellationToken,
    ) -> Result<(), McpError> {
        let entry = self.entry(server_id).await?;
        self.request(
            &entry,
            McpOperation::Unsubscribe,
            cancellation,
            entry
                .peer
                .unsubscribe(UnsubscribeRequestParams::new(uri.to_owned())),
        )
        .await
    }

    /// Receives one event. A single consumer owns each connection's ordered queue.
    pub async fn next_event(
        &self,
        server_id: &McpServerId,
        cancellation: &CancellationToken,
    ) -> Result<McpEvent, McpError> {
        let entry = self.entry(server_id).await?;
        let dropped = entry.dropped_events.swap(0, Ordering::AcqRel);
        if dropped > 0 {
            return Ok(McpEvent::Overflow { dropped });
        }
        let mut events = entry.events.lock().await;
        let receive = events.recv();
        tokio::select! {
            _ = cancellation.cancelled() => Err(McpError::Cancelled {
                operation: McpOperation::ReceiveEvent,
            }),
            _ = entry.lifetime.cancelled() => Err(McpError::EventStreamClosed),
            result = timeout(self.timeouts.request, receive) => match result {
                Ok(Some(event)) => Ok(event),
                Ok(None) => Err(McpError::EventStreamClosed),
                Err(_) => Err(McpError::Timeout {
                    operation: McpOperation::ReceiveEvent,
                    timeout: self.timeouts.request,
                }),
            }
        }
    }

    pub async fn disconnect(
        &self,
        server_id: &McpServerId,
        cancellation: &CancellationToken,
    ) -> Result<McpDisconnectReport, McpError> {
        let entry = self
            .connections
            .write()
            .await
            .remove(server_id)
            .ok_or_else(|| McpError::NotConnected {
                server_id: server_id.as_str().to_owned(),
            })?;
        entry.close(cancellation).await
    }

    /// Cancels admission and deterministically closes every current connection.
    pub async fn shutdown(&self) -> Vec<(McpServerId, Result<McpDisconnectReport, McpError>)> {
        self.root_cancellation.cancel();
        let entries = {
            let mut connections = self.connections.write().await;
            connections
                .drain()
                .map(|(_, entry)| entry)
                .collect::<Vec<_>>()
        };
        let never_cancelled = CancellationToken::new();
        let mut reports = Vec::with_capacity(entries.len());
        for entry in entries {
            reports.push((entry.id.clone(), entry.close(&never_cancelled).await));
        }
        reports
    }

    async fn ensure_available(&self, server_id: &McpServerId) -> Result<(), McpError> {
        if self.connections.read().await.contains_key(server_id) {
            return Err(McpError::AlreadyConnected {
                server_id: server_id.as_str().to_owned(),
            });
        }
        Ok(())
    }

    async fn install(
        &self,
        server_id: McpServerId,
        entry: Arc<ConnectionEntry>,
        cancellation: &CancellationToken,
    ) -> Result<(), McpError> {
        let duplicate = {
            let mut connections = self.connections.write().await;
            if connections.contains_key(&server_id) {
                true
            } else {
                connections.insert(server_id.clone(), entry.clone());
                false
            }
        };
        if duplicate {
            let _cleanup = entry.close(cancellation).await;
            return Err(McpError::AlreadyConnected {
                server_id: server_id.as_str().to_owned(),
            });
        }
        Ok(())
    }

    async fn initialize<T, E, A>(
        &self,
        transport: T,
        transport_kind: McpTransportKind,
        redactor: EventRedactor,
        lifetime: CancellationToken,
        cancellation: &CancellationToken,
    ) -> Result<
        (
            ClientService,
            mpsc::Receiver<McpEvent>,
            Arc<AtomicU64>,
            ServerInfo,
        ),
        McpError,
    >
    where
        T: IntoTransport<RoleClient, E, A>,
        E: std::error::Error + Send + Sync + 'static,
    {
        let (handler, events, dropped_events) =
            CodezClientHandler::new(self.limits.event_capacity, redactor);
        let serve = handler.serve_with_ct(transport, lifetime.clone());
        let service = tokio::select! {
            _ = cancellation.cancelled() => return Err(McpError::Cancelled {
                operation: McpOperation::Connect,
            }),
            _ = self.root_cancellation.cancelled() => return Err(McpError::Cancelled {
                operation: McpOperation::Connect,
            }),
            result = timeout(self.timeouts.connect, serve) => match result {
                Ok(Ok(service)) => service,
                Ok(Err(_initialize_error)) => return Err(McpError::Protocol {
                    operation: McpOperation::Connect,
                    transport: transport_kind,
                }),
                Err(_) => return Err(McpError::Timeout {
                    operation: McpOperation::Connect,
                    timeout: self.timeouts.connect,
                }),
            }
        };
        let server_info = service
            .peer()
            .peer_info()
            .ok_or(McpError::Protocol {
                operation: McpOperation::Connect,
                transport: transport_kind,
            })?
            .as_ref()
            .clone();
        Ok((service, events, dropped_events, server_info))
    }

    async fn install_page<T>(
        &self,
        category: &'static str,
        target: &mut Vec<T>,
        page: Vec<T>,
    ) -> Result<(), McpError> {
        if target.len().saturating_add(page.len()) > self.limits.max_catalog_items {
            return Err(McpError::CatalogLimit {
                category,
                limit: self.limits.max_catalog_items,
            });
        }
        target.extend(page);
        Ok(())
    }

    fn advance_cursor(
        &self,
        category: &'static str,
        seen: &mut HashSet<String>,
        next_cursor: Option<String>,
        pages: usize,
    ) -> Result<Option<String>, McpError> {
        if pages >= self.limits.max_catalog_pages && next_cursor.is_some() {
            return Err(McpError::PaginationLimit {
                category,
                limit: self.limits.max_catalog_pages,
            });
        }
        if let Some(cursor) = next_cursor.as_ref() {
            if !seen.insert(cursor.clone()) {
                return Err(McpError::PaginationCycle { category });
            }
        }
        Ok(next_cursor)
    }

    async fn list_tools(
        &self,
        entry: &Arc<ConnectionEntry>,
        cancellation: &CancellationToken,
    ) -> Result<Vec<Tool>, McpError> {
        let mut items = Vec::new();
        let mut cursor = None;
        let mut seen = HashSet::new();
        let mut pages = 0;
        loop {
            let result = self
                .request(
                    entry,
                    McpOperation::ListTools,
                    cancellation,
                    entry
                        .peer
                        .list_tools(Some(PaginatedRequestParams::default().with_cursor(cursor))),
                )
                .await?;
            pages += 1;
            self.install_page("tools", &mut items, result.tools).await?;
            cursor = self.advance_cursor("tools", &mut seen, result.next_cursor, pages)?;
            if cursor.is_none() {
                return Ok(items);
            }
        }
    }

    async fn list_resources(
        &self,
        entry: &Arc<ConnectionEntry>,
        cancellation: &CancellationToken,
    ) -> Result<Vec<Resource>, McpError> {
        let mut items = Vec::new();
        let mut cursor = None;
        let mut seen = HashSet::new();
        let mut pages = 0;
        loop {
            let result = self
                .request(
                    entry,
                    McpOperation::ListResources,
                    cancellation,
                    entry.peer.list_resources(Some(
                        PaginatedRequestParams::default().with_cursor(cursor),
                    )),
                )
                .await?;
            pages += 1;
            self.install_page("resources", &mut items, result.resources)
                .await?;
            cursor = self.advance_cursor("resources", &mut seen, result.next_cursor, pages)?;
            if cursor.is_none() {
                return Ok(items);
            }
        }
    }

    async fn list_resource_templates(
        &self,
        entry: &Arc<ConnectionEntry>,
        cancellation: &CancellationToken,
    ) -> Result<Vec<ResourceTemplate>, McpError> {
        let mut items = Vec::new();
        let mut cursor = None;
        let mut seen = HashSet::new();
        let mut pages = 0;
        loop {
            let result = self
                .request(
                    entry,
                    McpOperation::ListResourceTemplates,
                    cancellation,
                    entry.peer.list_resource_templates(Some(
                        PaginatedRequestParams::default().with_cursor(cursor),
                    )),
                )
                .await?;
            pages += 1;
            self.install_page("resource_templates", &mut items, result.resource_templates)
                .await?;
            cursor =
                self.advance_cursor("resource_templates", &mut seen, result.next_cursor, pages)?;
            if cursor.is_none() {
                return Ok(items);
            }
        }
    }

    async fn list_prompts(
        &self,
        entry: &Arc<ConnectionEntry>,
        cancellation: &CancellationToken,
    ) -> Result<Vec<Prompt>, McpError> {
        let mut items = Vec::new();
        let mut cursor = None;
        let mut seen = HashSet::new();
        let mut pages = 0;
        loop {
            let result = self
                .request(
                    entry,
                    McpOperation::ListPrompts,
                    cancellation,
                    entry
                        .peer
                        .list_prompts(Some(PaginatedRequestParams::default().with_cursor(cursor))),
                )
                .await?;
            pages += 1;
            self.install_page("prompts", &mut items, result.prompts)
                .await?;
            cursor = self.advance_cursor("prompts", &mut seen, result.next_cursor, pages)?;
            if cursor.is_none() {
                return Ok(items);
            }
        }
    }

    async fn request<T, F>(
        &self,
        entry: &ConnectionEntry,
        operation: McpOperation,
        cancellation: &CancellationToken,
        request: F,
    ) -> Result<T, McpError>
    where
        F: Future<Output = Result<T, ServiceError>>,
    {
        tokio::select! {
            _ = cancellation.cancelled() => Err(McpError::Cancelled { operation }),
            _ = entry.lifetime.cancelled() => Err(McpError::NotConnected {
                server_id: entry.id.as_str().to_owned(),
            }),
            result = timeout(self.timeouts.request, request) => match result {
                Ok(Ok(value)) => Ok(value),
                Ok(Err(_service_error)) => Err(McpError::Protocol {
                    operation,
                    transport: entry.transport,
                }),
                Err(_) => Err(McpError::Timeout {
                    operation,
                    timeout: self.timeouts.request,
                }),
            }
        }
    }

    async fn entry(&self, server_id: &McpServerId) -> Result<Arc<ConnectionEntry>, McpError> {
        self.connections
            .read()
            .await
            .get(server_id)
            .cloned()
            .ok_or_else(|| McpError::NotConnected {
                server_id: server_id.as_str().to_owned(),
            })
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{McpGatewayLimits, McpServerId, McpTimeouts};

    #[test]
    fn server_id_rejects_control_characters() {
        assert!(McpServerId::new("server\nforged").is_err());
    }

    #[test]
    fn timeout_config_rejects_zero_durations() {
        assert!(
            McpTimeouts::new(
                Duration::ZERO,
                Duration::from_secs(1),
                Duration::from_secs(1)
            )
            .is_err()
        );
    }

    #[test]
    fn gateway_limits_reject_zero_capacity() {
        assert!(McpGatewayLimits::new(0, 1, 1, 1).is_err());
    }
}
