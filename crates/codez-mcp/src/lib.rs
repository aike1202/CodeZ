#![forbid(unsafe_code)]

//! Production MCP client adapter backed by the official `rmcp` SDK.

pub mod client;
pub mod config;
pub mod error;
pub mod gateway;
pub mod secret;
pub mod transports;

pub use client::{McpCatalogKind, McpEvent};
pub use config::{
    McpApprovalPolicy, McpConfigError, McpInstructionsPolicy, McpOAuthConfig, McpReconnectPolicy,
    McpServerConfig, McpTransport, McpUserConfigService, UserMcpServer,
};
pub use error::{McpError, McpOperation, McpTransportKind};
pub use gateway::{
    McpCatalog, McpConnectionInfo, McpDisconnectReport, McpGateway, McpGatewayLimits, McpServerId,
    McpTimeouts,
};
pub use secret::{
    McpSecretError, McpSecretKey, McpSecretService, McpSecretStore, McpSecretStoreError,
    McpSecretValue, SecretFuture,
};
pub use transports::{StderrSummary, StdioServerConfig, StreamableHttpServerConfig};
