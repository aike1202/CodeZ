use std::collections::{BTreeMap, HashMap};

use http::{HeaderName, HeaderValue};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use url::Url;

use crate::McpError;

/// Validated configuration for an MCP Streamable HTTP endpoint.
pub struct StreamableHttpServerConfig {
    endpoint: String,
    redacted_endpoint: String,
    headers: HashMap<HeaderName, HeaderValue>,
    bearer_token: Option<String>,
    redaction_values: Vec<String>,
}

impl std::fmt::Debug for StreamableHttpServerConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let header_names = self
            .headers
            .keys()
            .map(HeaderName::as_str)
            .collect::<Vec<_>>();
        formatter
            .debug_struct("StreamableHttpServerConfig")
            .field("endpoint", &self.redacted_endpoint)
            .field("header_names", &header_names)
            .field("has_bearer_token", &self.bearer_token.is_some())
            .finish()
    }
}

impl StreamableHttpServerConfig {
    /// Validates an HTTP endpoint and custom headers without retaining an
    /// unredacted representation for diagnostics.
    pub fn new(endpoint: &str, headers: BTreeMap<String, String>) -> Result<Self, McpError> {
        let parsed = Url::parse(endpoint).map_err(|_| McpError::InvalidEndpoint)?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(McpError::UnsupportedEndpointScheme);
        }
        let mut redacted = parsed.clone();
        if redacted.query().is_some() {
            redacted.set_query(Some("REDACTED"));
        }
        if redacted.fragment().is_some() {
            redacted.set_fragment(Some("REDACTED"));
        }

        let mut parsed_headers = HashMap::with_capacity(headers.len());
        let mut redaction_values = Vec::with_capacity(headers.len());
        for (name, value) in headers {
            let header_name = name
                .parse::<HeaderName>()
                .map_err(|_| McpError::InvalidHeaderName { name: name.clone() })?;
            let header_value = value
                .parse::<HeaderValue>()
                .map_err(|_| McpError::InvalidHeaderValue { name })?;
            redaction_values.push(value);
            parsed_headers.insert(header_name, header_value);
        }

        Ok(Self {
            endpoint: parsed.into(),
            redacted_endpoint: redacted.into(),
            headers: parsed_headers,
            bearer_token: None,
            redaction_values,
        })
    }

    /// Adds a bearer token using rmcp's dedicated authorization path.
    #[must_use]
    pub fn with_bearer_token(mut self, bearer_token: String) -> Self {
        self.redaction_values.push(bearer_token.clone());
        self.bearer_token = Some(bearer_token);
        self
    }

    pub(crate) fn into_parts(
        self,
        channel_buffer_capacity: usize,
    ) -> (StreamableHttpClientTransportConfig, Vec<String>) {
        let mut config = StreamableHttpClientTransportConfig::with_uri(self.endpoint)
            .custom_headers(self.headers)
            .reinit_on_expired_session(false);
        config.channel_buffer_capacity = channel_buffer_capacity;
        if let Some(bearer_token) = self.bearer_token {
            config = config.auth_header(bearer_token);
        }
        (config, self.redaction_values)
    }

    pub(crate) fn into_legacy_sse_parts(self) -> super::sse::LegacySseTransportConfig {
        super::sse::LegacySseTransportConfig {
            endpoint: self.endpoint,
            headers: self.headers,
            bearer_token: self.bearer_token,
            redaction_values: self.redaction_values,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::StreamableHttpServerConfig;
    use crate::McpError;

    #[test]
    fn debug_output_redacts_endpoint_query_and_header_values() {
        let config = StreamableHttpServerConfig::new(
            "https://example.test/mcp?token=query-secret",
            BTreeMap::from([("x-api-key".to_owned(), "header-secret".to_owned())]),
        )
        .expect("valid HTTP config should be built");

        let debug = format!("{config:?}");

        assert!(!debug.contains("query-secret"));
        assert!(!debug.contains("header-secret"));
        assert!(debug.contains("REDACTED"));
    }

    #[test]
    fn config_rejects_non_http_schemes() {
        let error = StreamableHttpServerConfig::new("file:///tmp/mcp", BTreeMap::new())
            .expect_err("file endpoints must be rejected");

        assert!(matches!(error, McpError::UnsupportedEndpointScheme));
    }
}
