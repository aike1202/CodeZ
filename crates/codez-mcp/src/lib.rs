#![forbid(unsafe_code)]

//! Production MCP client adapter backed by the official `rmcp` SDK.

pub mod client;
pub mod config;
pub mod error;
pub mod gateway;
pub mod oauth;
pub mod secret;
pub mod transports;

pub use client::{
    McpCatalogKind, McpEvent, McpReverseRequestFuture, McpReverseRequestHandler,
    McpReverseRequestKind, McpReverseRequestPolicy,
};
pub use config::{
    McpApprovalPolicy, McpConfigError, McpConfigScope, McpInstructionsPolicy, McpOAuthConfig,
    McpProjectConfigService, McpReconnectPolicy, McpServerConfig, McpTransport,
    McpUserConfigService, ScopedMcpServer, merge_scoped_servers,
};
pub use error::{McpError, McpOperation, McpTransportKind};
pub use gateway::{
    McpCatalog, McpConnectionInfo, McpDisconnectReport, McpGateway, McpGatewayLimits, McpServerId,
    McpTimeouts,
};
pub use oauth::{McpOAuthAuthorization, McpOAuthClient, McpOAuthCredentialStore, McpOAuthError};
pub use secret::{
    McpSecretError, McpSecretKey, McpSecretService, McpSecretStore, McpSecretStoreError,
    McpSecretValue, SecretFuture,
};
pub use transports::{StderrSummary, StdioServerConfig, StreamableHttpServerConfig};
