use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::client::McpClient;
use crate::transports::stdio::StdioTransport;
use crate::transports::sse::SseTransport;

pub enum TransportType {
    Stdio(StdioTransport),
    Sse(SseTransport),
}

pub struct McpGateway {
    clients: Arc<Mutex<HashMap<String, McpClient>>>,
    transports: Arc<Mutex<HashMap<String, TransportType>>>,
}

impl McpGateway {
    pub fn new() -> Self {
        Self {
            clients: Arc::new(Mutex::new(HashMap::new())),
            transports: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn register_stdio_client(
        &self,
        name: String,
        version: String,
        command: &str,
        args: &[String],
    ) -> Result<(), String> {
        let client = McpClient::new(name.clone(), version);
        let transport = StdioTransport::new(command, args)?;

        let mut clients = self.clients.lock().await;
        let mut transports = self.transports.lock().await;

        clients.insert(name.clone(), client);
        transports.insert(name, TransportType::Stdio(transport));

        Ok(())
    }

    pub async fn register_sse_client(
        &self,
        name: String,
        version: String,
        endpoint: String,
    ) {
        let client = McpClient::new(name.clone(), version);
        let transport = SseTransport::new(endpoint);

        let mut clients = self.clients.lock().await;
        let mut transports = self.transports.lock().await;

        clients.insert(name.clone(), client);
        transports.insert(name, TransportType::Sse(transport));
    }

    pub async fn send_to_client(&self, client_name: &str, payload: &str) -> Result<(), String> {
        let mut transports = self.transports.lock().await;
        if let Some(t) = transports.get_mut(client_name) {
            match t {
                TransportType::Stdio(s) => s.send_raw(payload).await?,
                TransportType::Sse(s) => s.send_message(payload).await?,
            }
            Ok(())
        } else {
            Err(format!("Client '{}' not found in gateway", client_name))
        }
    }
}
