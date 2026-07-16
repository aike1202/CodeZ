use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpRequest {
    pub jsonrpc: String,
    pub method: String,
    pub params: Value,
    pub id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpResponse {
    pub jsonrpc: String,
    pub result: Option<Value>,
    pub error: Option<Value>,
    pub id: u64,
}

pub struct McpClient {
    pub name: String,
    pub version: String,
}

impl McpClient {
    pub fn new(name: String, version: String) -> Self {
        Self { name, version }
    }

    pub fn prepare_initialize(&self) -> McpRequest {
        McpRequest {
            jsonrpc: "2.0".to_string(),
            method: "initialize".to_string(),
            params: serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": self.name,
                    "version": self.version
                }
            }),
            id: 1,
        }
    }
}
