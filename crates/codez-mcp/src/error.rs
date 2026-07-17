use std::{io, path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Transport families understood by the CodeZ MCP gateway.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpTransportKind {
    Stdio,
    StreamableHttp,
    LegacySse,
}

/// Stable names for timeout and cancellation reporting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpOperation {
    Connect,
    ListTools,
    ListResources,
    ListResourceTemplates,
    ListPrompts,
    GetPrompt,
    CallTool,
    ReadResource,
    Subscribe,
    Unsubscribe,
    ReceiveEvent,
    Close,
}

/// Failures surfaced by the production MCP adapter.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum McpError {
    #[error("MCP server id must be non-empty and no longer than {max_bytes} bytes")]
    InvalidServerId { max_bytes: usize },
    #[error("MCP server '{server_id}' is already connected")]
    AlreadyConnected { server_id: String },
    #[error("MCP server '{server_id}' is not connected")]
    NotConnected { server_id: String },
    #[error("MCP stdio executable path must be absolute: {path}", path = .path.display())]
    RelativeExecutable { path: PathBuf },
    #[error("MCP stdio working directory must be absolute: {path}", path = .path.display())]
    RelativeWorkingDirectory { path: PathBuf },
    #[error("MCP limit '{name}' must be greater than zero")]
    InvalidLimit { name: &'static str },
    #[error("MCP HTTP endpoint is invalid")]
    InvalidEndpoint,
    #[error("MCP HTTP endpoint must use http or https")]
    UnsupportedEndpointScheme,
    #[error("MCP HTTP header name is invalid: {name}")]
    InvalidHeaderName { name: String },
    #[error("MCP HTTP header value is invalid for header: {name}")]
    InvalidHeaderValue { name: String },
    #[error("legacy SSE MCP transport is not supported by the production gateway")]
    UnsupportedTransport { transport: McpTransportKind },
    #[error("failed to spawn the MCP stdio process")]
    Spawn(#[source] io::Error),
    #[error("failed to supervise the MCP stdio process")]
    Process(#[source] io::Error),
    #[error("the MCP stdio stderr drain failed")]
    Stderr(#[source] io::Error),
    #[error("the MCP background task failed")]
    BackgroundTask,
    #[error("MCP {operation:?} was cancelled")]
    Cancelled { operation: McpOperation },
    #[error("MCP {operation:?} timed out after {timeout:?}")]
    Timeout {
        operation: McpOperation,
        timeout: Duration,
    },
    #[error("MCP {operation:?} failed over {transport:?}")]
    Protocol {
        operation: McpOperation,
        transport: McpTransportKind,
    },
    #[error("MCP catalog exceeded the {limit} item limit for {category}")]
    CatalogLimit {
        category: &'static str,
        limit: usize,
    },
    #[error("MCP server repeated a pagination cursor for {category}")]
    PaginationCycle { category: &'static str },
    #[error("MCP server exceeded the {limit} page limit for {category}")]
    PaginationLimit {
        category: &'static str,
        limit: usize,
    },
    #[error("MCP event stream is closed")]
    EventStreamClosed,
}
