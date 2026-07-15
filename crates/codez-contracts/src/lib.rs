#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const CONTRACT_VERSION: u16 = 1;
pub const THEME_CHANGED_EVENT: &str = "desktop://theme-changed";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    Validation,
    PermissionDenied,
    NotFound,
    Conflict,
    External,
    ProcessFailed,
    Cancelled,
    Timeout,
    Storage,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct CommandError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    pub correlation_id: Option<String>,
}

impl CommandError {
    #[must_use]
    pub fn validation(message: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::Validation,
            message: message.into(),
            retryable: false,
            correlation_id: None,
        }
    }

    #[must_use]
    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::Internal,
            message: message.into(),
            retryable: false,
            correlation_id: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct HealthResponse {
    pub contract_version: u16,
    pub backend_version: String,
    #[ts(type = "number")]
    pub uptime_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SystemProbeEvent {
    pub step: u16,
    pub total: u16,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum WindowAction {
    Minimize,
    ToggleMaximize,
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum ThemeSource {
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ThemeInfo {
    pub should_use_dark_colors: bool,
    pub theme_source: ThemeSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct DesktopEvent<T> {
    pub version: u16,
    pub stream_id: Option<String>,
    #[ts(type = "number | null")]
    pub sequence: Option<u64>,
    pub kind: String,
    pub payload: T,
}

#[cfg(test)]
mod tests {
    use super::{
        CommandError, DesktopEvent, ErrorCode, SystemProbeEvent, ThemeInfo, ThemeSource,
        WindowAction,
    };

    #[test]
    fn validation_errors_are_not_retryable() {
        let error = CommandError::validation("invalid input");

        assert_eq!(error.code, ErrorCode::Validation);
        assert!(!error.retryable);
        assert!(error.correlation_id.is_none());
    }

    #[test]
    fn window_actions_use_stable_camel_case_values() {
        let value = serde_json::to_string(&WindowAction::ToggleMaximize)
            .expect("serializing a fixed enum cannot fail");

        assert_eq!(value, "\"toggleMaximize\"");
    }

    #[test]
    fn theme_events_use_the_versioned_envelope() {
        let event = DesktopEvent {
            version: 1,
            stream_id: None,
            sequence: None,
            kind: "themeChanged".to_string(),
            payload: ThemeInfo {
                should_use_dark_colors: true,
                theme_source: ThemeSource::System,
            },
        };
        let value = serde_json::to_value(event).expect("fixture event must serialize");

        assert_eq!(value["version"], 1);
        assert_eq!(value["kind"], "themeChanged");
        assert_eq!(value["payload"]["themeSource"], "system");
    }

    #[test]
    fn system_probe_events_keep_numeric_progress() {
        let event = SystemProbeEvent {
            step: 2,
            total: 3,
            label: "channelReady".to_string(),
        };
        let value = serde_json::to_value(event).expect("fixture event must serialize");

        assert_eq!(value["step"], 2);
        assert_eq!(value["total"], 3);
    }
}
