#![expect(
    deprecated,
    reason = "CodeZ must receive logging and reject sampling until existing MCP servers migrate"
)]

use std::{
    future::{Future, ready},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use rmcp::{
    ClientHandler, ErrorData as ProtocolError, RoleClient,
    model::{
        ClientCapabilities, ClientInfo, CreateMessageRequestMethod, CreateMessageRequestParams,
        CreateMessageResult, CustomNotification, ElicitRequestParams, ElicitResult,
        ElicitationAction, Implementation, LoggingMessageNotificationParam,
        ProgressNotificationParam, ResourceUpdatedNotificationParam,
    },
    service::{MaybeSendFuture, NotificationContext, RequestContext},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use url::Url;

/// Catalog category invalidated by a server notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpCatalogKind {
    Tools,
    Resources,
    Prompts,
}

/// Bounded, redacted events owned by one gateway connection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpEvent {
    Logging {
        level: String,
        logger: Option<String>,
        data: Value,
    },
    Progress {
        progress_token: Value,
        progress: f64,
        total: Option<f64>,
        message: Option<String>,
    },
    ResourceUpdated {
        uri: String,
    },
    CatalogChanged {
        catalog: McpCatalogKind,
    },
    CustomNotification {
        method: String,
    },
    Overflow {
        dropped: u64,
    },
}

#[derive(Clone)]
pub(crate) struct EventRedactor {
    secrets: Arc<[String]>,
}

impl EventRedactor {
    pub(crate) fn new(secrets: impl IntoIterator<Item = String>) -> Self {
        let secrets = secrets
            .into_iter()
            .filter(|secret| secret.len() >= 3)
            .collect::<Vec<_>>();
        Self {
            secrets: secrets.into(),
        }
    }

    fn text(&self, value: &str) -> String {
        let mut redacted = value.to_owned();
        for secret in self.secrets.iter() {
            redacted = redacted.replace(secret, "[REDACTED]");
        }

        if let Ok(mut url) = Url::parse(&redacted) {
            if url.query().is_some() {
                url.set_query(Some("REDACTED"));
            }
            if url.fragment().is_some() {
                url.set_fragment(Some("REDACTED"));
            }
            return url.into();
        }
        redacted
    }

    fn value(&self, value: Value) -> Value {
        match value {
            Value::String(value) => Value::String(self.text(&value)),
            Value::Array(values) => {
                Value::Array(values.into_iter().map(|value| self.value(value)).collect())
            }
            Value::Object(values) => Value::Object(
                values
                    .into_iter()
                    .map(|(key, value)| {
                        if is_sensitive_key(&key) {
                            (key, Value::String("[REDACTED]".to_owned()))
                        } else {
                            (key, self.value(value))
                        }
                    })
                    .collect(),
            ),
            other => other,
        }
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    [
        "authorization",
        "password",
        "secret",
        "token",
        "api_key",
        "api-key",
        "apikey",
    ]
    .iter()
    .any(|candidate| normalized.contains(candidate))
}

#[derive(Debug, Clone, Copy)]
enum ReverseRequestPolicy {
    Deny,
}

#[derive(Clone)]
pub(crate) struct CodezClientHandler {
    events: mpsc::Sender<McpEvent>,
    dropped_events: Arc<AtomicU64>,
    redactor: EventRedactor,
    reverse_requests: ReverseRequestPolicy,
}

impl CodezClientHandler {
    pub(crate) fn new(
        event_capacity: usize,
        redactor: EventRedactor,
    ) -> (Self, mpsc::Receiver<McpEvent>, Arc<AtomicU64>) {
        let (events, receiver) = mpsc::channel(event_capacity);
        let dropped_events = Arc::new(AtomicU64::new(0));
        (
            Self {
                events,
                dropped_events: dropped_events.clone(),
                redactor,
                reverse_requests: ReverseRequestPolicy::Deny,
            },
            receiver,
            dropped_events,
        )
    }

    fn emit(&self, event: McpEvent) {
        if matches!(
            self.events.try_send(event),
            Err(mpsc::error::TrySendError::Full(_))
        ) {
            self.dropped_events.fetch_add(1, Ordering::Relaxed);
        }
    }
}

impl ClientHandler for CodezClientHandler {
    fn get_info(&self) -> ClientInfo {
        ClientInfo::new(
            ClientCapabilities::default(),
            Implementation::new("CodeZ", env!("CARGO_PKG_VERSION")),
        )
    }

    fn create_message(
        &self,
        _params: CreateMessageRequestParams,
        _context: RequestContext<RoleClient>,
    ) -> impl Future<Output = Result<CreateMessageResult, ProtocolError>> + MaybeSendFuture + '_
    {
        let result = match self.reverse_requests {
            ReverseRequestPolicy::Deny => {
                Err(ProtocolError::method_not_found::<CreateMessageRequestMethod>())
            }
        };
        ready(result)
    }

    fn create_elicitation(
        &self,
        _request: ElicitRequestParams,
        _context: RequestContext<RoleClient>,
    ) -> impl Future<Output = Result<ElicitResult, ProtocolError>> + MaybeSendFuture + '_ {
        ready(Ok(ElicitResult::new(ElicitationAction::Decline)))
    }

    fn on_logging_message(
        &self,
        params: LoggingMessageNotificationParam,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        self.emit(McpEvent::Logging {
            level: format!("{:?}", params.level).to_ascii_lowercase(),
            logger: params.logger.map(|logger| self.redactor.text(&logger)),
            data: self.redactor.value(params.data),
        });
        ready(())
    }

    fn on_progress(
        &self,
        params: ProgressNotificationParam,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        let token = serde_json::to_value(params.progress_token)
            .unwrap_or_else(|_| Value::String("[invalid progress token]".to_owned()));
        self.emit(McpEvent::Progress {
            progress_token: self.redactor.value(token),
            progress: params.progress,
            total: params.total,
            message: params.message.map(|message| self.redactor.text(&message)),
        });
        ready(())
    }

    fn on_resource_updated(
        &self,
        params: ResourceUpdatedNotificationParam,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        self.emit(McpEvent::ResourceUpdated {
            uri: self.redactor.text(&params.uri),
        });
        ready(())
    }

    fn on_resource_list_changed(
        &self,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        self.emit(McpEvent::CatalogChanged {
            catalog: McpCatalogKind::Resources,
        });
        ready(())
    }

    fn on_tool_list_changed(
        &self,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        self.emit(McpEvent::CatalogChanged {
            catalog: McpCatalogKind::Tools,
        });
        ready(())
    }

    fn on_prompt_list_changed(
        &self,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        self.emit(McpEvent::CatalogChanged {
            catalog: McpCatalogKind::Prompts,
        });
        ready(())
    }

    fn on_custom_notification(
        &self,
        notification: CustomNotification,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        self.emit(McpEvent::CustomNotification {
            method: self.redactor.text(&notification.method),
        });
        ready(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::EventRedactor;

    #[test]
    fn redactor_removes_configured_secrets_sensitive_fields_and_url_queries() {
        let redactor = EventRedactor::new(["mcp-secret".to_owned()]);
        let value = json!({
            "message": "token=mcp-secret",
            "apiKey": "another-secret",
            "url": "https://example.test/path?token=mcp-secret#fragment"
        });

        let redacted = redactor.value(value);

        assert_eq!(redacted["message"], "token=[REDACTED]");
        assert_eq!(redacted["apiKey"], "[REDACTED]");
        assert_eq!(
            redacted["url"],
            "https://example.test/path?REDACTED#REDACTED"
        );
    }
}
