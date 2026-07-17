use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use codez_runtime::tools::{
    registry::{
        BoxFuture, DefaultToolDescriptor, ToolAvailability, ToolBehavior, ToolContext,
        ToolDescriptor, ToolHandler,
    },
    types::{
        ModelPreference, ToolApprovalMetadata, ToolConcurrency, ToolEffect, ToolEffectPlan,
        ToolExecutionError, ToolExecutionResult, ToolExposure, ToolInterruptBehavior,
        ToolPlanningContext, ToolSource,
    },
};
use serde_json::Value;
use tauri::{AppHandle, Wry, plugin::PermissionState};
use tauri_plugin_notification::NotificationExt;

const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(60);
const MAX_NOTIFICATIONS_PER_WINDOW: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NotificationPermission {
    Granted,
    Denied,
    Prompt,
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "platform notification ports may report unsupported"
        )
    )]
    Unsupported,
}

#[async_trait::async_trait]
pub(crate) trait NotificationPort: Send + Sync {
    async fn permission(&self) -> Result<NotificationPermission, String>;
    async fn submit(&self, title: &str, body: &str) -> Result<(), String>;
}

#[cfg(test)]
pub(crate) struct UnsupportedNotificationPort;

#[cfg(test)]
#[async_trait::async_trait]
impl NotificationPort for UnsupportedNotificationPort {
    async fn permission(&self) -> Result<NotificationPermission, String> {
        Ok(NotificationPermission::Unsupported)
    }

    async fn submit(&self, _title: &str, _body: &str) -> Result<(), String> {
        Err("Desktop notifications are unavailable".to_string())
    }
}

pub(crate) struct TauriNotificationPort {
    app: AppHandle<Wry>,
}

impl TauriNotificationPort {
    pub(crate) fn new(app: AppHandle<Wry>) -> Self {
        Self { app }
    }
}

#[async_trait::async_trait]
impl NotificationPort for TauriNotificationPort {
    async fn permission(&self) -> Result<NotificationPermission, String> {
        self.app
            .notification()
            .permission_state()
            .map(|state| match state {
                PermissionState::Granted => NotificationPermission::Granted,
                PermissionState::Denied => NotificationPermission::Denied,
                PermissionState::Prompt => NotificationPermission::Prompt,
                PermissionState::PromptWithRationale => NotificationPermission::Prompt,
            })
            .map_err(|error| error.to_string())
    }

    async fn submit(&self, title: &str, body: &str) -> Result<(), String> {
        self.app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|error| error.to_string())
    }
}

pub(crate) struct PushNotificationTool {
    descriptor: DefaultToolDescriptor,
    port: Arc<dyn NotificationPort>,
    recent: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl PushNotificationTool {
    pub(crate) fn new(port: Arc<dyn NotificationPort>) -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name: "PushNotification",
                version: "1.0.0",
                source: ToolSource::Builtin,
                source_id: "builtin:push-notification".to_string(),
                summary: "Send a desktop push notification.".to_string(),
                description: "Send a desktop notification sparingly when the user may have walked away or explicitly requests one. The message must be one line, contain no Markdown, and be at most 200 characters. A sent result means the OS notification service accepted submission; desktop click callbacks are not claimed.".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "message": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 200,
                            "description": "One-line notification body without Markdown."
                        },
                        "status": {
                            "type": "string",
                            "enum": ["info", "success", "warning", "error"],
                            "default": "info"
                        }
                    },
                    "required": ["message"]
                }),
                approval: ToolApprovalMetadata {
                    model_preference: ModelPreference::NotApplicable,
                },
                availability: ToolAvailability {
                    roles: None,
                    platforms: None,
                    exposure: ToolExposure::Deferred,
                },
                behavior: ToolBehavior {
                    concurrency: ToolConcurrency::ResourceLocked,
                    interrupt: ToolInterruptBehavior::Cancel,
                    max_result_chars: 8 * 1024,
                    timeout_ms: Some(10_000),
                },
            },
            port,
            recent: Mutex::new(HashMap::new()),
        }
    }

    fn admit(&self, session_id: &str, now: Instant) -> Result<(), ToolExecutionError> {
        let mut recent = self
            .recent
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entries = recent.entry(session_id.to_string()).or_default();
        while entries
            .front()
            .is_some_and(|timestamp| now.duration_since(*timestamp) >= RATE_LIMIT_WINDOW)
        {
            entries.pop_front();
        }
        if entries.len() >= MAX_NOTIFICATIONS_PER_WINDOW {
            let retry_after_ms = entries.front().map(|timestamp| {
                let remaining = RATE_LIMIT_WINDOW.saturating_sub(now.duration_since(*timestamp));
                u32::try_from(remaining.as_millis()).unwrap_or(u32::MAX)
            });
            let mut error = tool_error(
                "NOTIFICATION_RATE_LIMITED",
                "Desktop notification rate limit reached.",
                true,
            );
            error.retry_after_ms = retry_after_ms;
            return Err(error);
        }
        entries.push_back(now);
        Ok(())
    }
}

impl ToolHandler for PushNotificationTool {
    fn descriptor(&self) -> &dyn ToolDescriptor {
        &self.descriptor
    }

    fn plan_effects<'a>(
        &'a self,
        _input: &'a Value,
        _context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, ToolEffectPlan> {
        Box::pin(async {
            ToolEffectPlan {
                effects: vec![ToolEffect::NotifyUser {
                    channel: "desktop".to_string(),
                }],
                analysis_status: "parsed".to_string(),
            }
        })
    }

    fn resource_keys<'a>(
        &'a self,
        _input: &'a Value,
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move {
            vec![format!(
                "session:{}:desktop-notification",
                context.session_id.as_deref().unwrap_or("unknown")
            )]
        })
    }

    fn execute<'a>(
        &'a self,
        input: &'a Value,
        context: &'a ToolContext,
    ) -> BoxFuture<'a, ToolExecutionResult> {
        Box::pin(async move {
            let result = self.execute_notification(input, context).await;
            match result {
                Ok(data) => ToolExecutionResult::Success {
                    model_content: data.to_string(),
                    data: Some(data),
                    ui_content: None,
                    effects: Some(vec![ToolEffect::NotifyUser {
                        channel: "desktop".to_string(),
                    }]),
                },
                Err(error) => ToolExecutionResult::Error {
                    error,
                    model_content: None,
                    ui_content: None,
                    effects: None,
                },
            }
        })
    }
}

impl PushNotificationTool {
    async fn execute_notification(
        &self,
        input: &Value,
        context: &ToolContext,
    ) -> Result<Value, ToolExecutionError> {
        if context.cancellation.is_cancelled() {
            return Err(tool_error(
                "TOOL_CANCELLED",
                "Desktop notification was cancelled.",
                true,
            ));
        }
        let message = input
            .get("message")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|message| !message.is_empty())
            .ok_or_else(|| {
                tool_error(
                    "TOOL_INPUT_INVALID",
                    "Notification message is required.",
                    false,
                )
            })?;
        validate_message(message)?;
        let session_id = context.session_id.as_deref().ok_or_else(|| {
            tool_error(
                "TOOL_SESSION_REQUIRED",
                "Desktop notifications require an active session.",
                false,
            )
        })?;
        match self
            .port
            .permission()
            .await
            .map_err(|message| tool_error("NOTIFICATION_PERMISSION_FAILED", message, false))?
        {
            NotificationPermission::Granted => {}
            NotificationPermission::Denied => {
                return Err(tool_error(
                    "NOTIFICATION_PERMISSION_DENIED",
                    "Desktop notification permission is denied.",
                    false,
                ));
            }
            NotificationPermission::Prompt => {
                return Err(tool_error(
                    "NOTIFICATION_PERMISSION_REQUIRED",
                    "Desktop notification permission has not been granted.",
                    true,
                ));
            }
            NotificationPermission::Unsupported => {
                return Err(tool_error(
                    "NOTIFICATION_UNSUPPORTED",
                    "Desktop notifications are not supported on this host.",
                    false,
                ));
            }
        }
        self.admit(session_id, Instant::now())?;
        let status = input
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("info");
        let title = match status {
            "success" => "Success",
            "warning" => "Warning",
            "error" => "Error",
            _ => "Info",
        };
        self.port
            .submit(title, message)
            .await
            .map_err(|message| tool_error("NOTIFICATION_SEND_FAILED", message, true))?;
        Ok(serde_json::json!({
            "sent": true,
            "delivery": "submitted",
            "clickFocusSupported": false
        }))
    }
}

fn validate_message(message: &str) -> Result<(), ToolExecutionError> {
    if message.chars().count() > 200 {
        return Err(tool_error(
            "NOTIFICATION_MESSAGE_TOO_LONG",
            "Notification message must not exceed 200 characters.",
            false,
        ));
    }
    if message.contains(['\r', '\n']) {
        return Err(tool_error(
            "NOTIFICATION_MESSAGE_MULTILINE",
            "Notification message must be one line.",
            false,
        ));
    }
    let trimmed = message.trim_start();
    if message.contains('`')
        || message.contains("**")
        || message.contains("](")
        || trimmed.starts_with('#')
    {
        return Err(tool_error(
            "NOTIFICATION_MESSAGE_MARKDOWN",
            "Notification message must not contain Markdown.",
            false,
        ));
    }
    Ok(())
}

fn tool_error(code: &str, message: impl Into<String>, recoverable: bool) -> ToolExecutionError {
    ToolExecutionError {
        code: code.to_string(),
        message: message.into(),
        recoverable,
        suggestion: None,
        retry_after_ms: None,
        details: None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use codez_core::CancellationToken;

    use super::*;

    struct FakePort {
        permission: NotificationPermission,
        failure: Option<String>,
        submissions: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl NotificationPort for FakePort {
        async fn permission(&self) -> Result<NotificationPermission, String> {
            Ok(self.permission)
        }

        async fn submit(&self, _title: &str, _body: &str) -> Result<(), String> {
            self.submissions.fetch_add(1, Ordering::SeqCst);
            self.failure.clone().map_or(Ok(()), Err)
        }
    }

    fn context() -> ToolContext {
        ToolContext {
            execution_id: "execution-1".to_string(),
            call_id: "call-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            session_id: Some("session-1".to_string()),
            context_scope_id: "main".to_string(),
            transaction_id: None,
            workspace_root: std::env::temp_dir(),
            cancellation: CancellationToken::new(),
            authorized_effects: ToolEffectPlan {
                effects: Vec::new(),
                analysis_status: "parsed".to_string(),
            },
            file_services: None,
            deferred_tools: Vec::new(),
        }
    }

    fn error_code(result: &ToolExecutionResult) -> Option<&str> {
        match result {
            ToolExecutionResult::Success { .. } => None,
            ToolExecutionResult::Error { error, .. }
            | ToolExecutionResult::Denied { error, .. }
            | ToolExecutionResult::Cancelled { error, .. } => Some(&error.code),
        }
    }

    #[tokio::test]
    async fn denied_permission_returns_a_typed_error_without_submitting() {
        let port = Arc::new(FakePort {
            permission: NotificationPermission::Denied,
            failure: None,
            submissions: AtomicUsize::new(0),
        });
        let tool = PushNotificationTool::new(port.clone());
        let result = tool
            .execute(
                &serde_json::json!({"message": "Build finished"}),
                &context(),
            )
            .await;

        assert_eq!(
            (error_code(&result), port.submissions.load(Ordering::SeqCst)),
            (Some("NOTIFICATION_PERMISSION_DENIED"), 0)
        );
    }

    #[tokio::test]
    async fn unsupported_host_returns_a_typed_error_without_submitting() {
        let port = Arc::new(FakePort {
            permission: NotificationPermission::Unsupported,
            failure: None,
            submissions: AtomicUsize::new(0),
        });
        let tool = PushNotificationTool::new(port.clone());
        let result = tool
            .execute(
                &serde_json::json!({"message": "Build finished"}),
                &context(),
            )
            .await;

        assert_eq!(
            (error_code(&result), port.submissions.load(Ordering::SeqCst)),
            (Some("NOTIFICATION_UNSUPPORTED"), 0)
        );
    }

    #[tokio::test]
    async fn submit_failure_is_not_reported_as_sent() {
        let tool = PushNotificationTool::new(Arc::new(FakePort {
            permission: NotificationPermission::Granted,
            failure: Some("OS service unavailable".to_string()),
            submissions: AtomicUsize::new(0),
        }));
        let result = tool
            .execute(&serde_json::json!({"message": "Build failed"}), &context())
            .await;

        assert_eq!(error_code(&result), Some("NOTIFICATION_SEND_FAILED"));
    }

    #[test]
    fn message_policy_rejects_multiline_and_markdown_content() {
        assert!(validate_message("line one\nline two").is_err());
        assert!(validate_message("**done**").is_err());
    }

    #[test]
    fn rate_limiter_rejects_the_fourth_notification_in_one_minute() {
        let tool = PushNotificationTool::new(Arc::new(FakePort {
            permission: NotificationPermission::Granted,
            failure: None,
            submissions: AtomicUsize::new(0),
        }));
        let now = Instant::now();
        for _ in 0..MAX_NOTIFICATIONS_PER_WINDOW {
            tool.admit("session-1", now)
                .expect("notifications below the limit must be admitted");
        }

        let error = tool
            .admit("session-1", now)
            .expect_err("the fourth notification must be rate-limited");

        assert_eq!(error.code, "NOTIFICATION_RATE_LIMITED");
    }
}
