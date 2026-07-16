use crate::{McpError, McpTransportKind};

/// Returns the stable production error for the unsupported legacy `/sse` +
/// `/messages` MCP transport.
pub fn unsupported() -> McpError {
    McpError::UnsupportedTransport {
        transport: McpTransportKind::LegacySse,
    }
}
