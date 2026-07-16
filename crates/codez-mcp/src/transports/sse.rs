pub struct SseTransport {
    pub endpoint: String,
}

impl SseTransport {
    pub fn new(endpoint: String) -> Self {
        Self { endpoint }
    }

    pub async fn send_message(&self, payload: &str) -> Result<(), String> {
        let client = reqwest::Client::new();
        let _res = client.post(&self.endpoint)
            .header("Content-Type", "application/json")
            .body(payload.to_string())
            .send()
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
