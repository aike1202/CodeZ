#![forbid(unsafe_code)]

pub mod provider;
pub mod chat;
pub mod context;

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
pub struct WorkspaceInfo {
    pub id: String,
    pub root_path: String,
    pub name: String,
    pub project_type: String,
    pub opened_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum FileTreeNodeType {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct FileTreeNode {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    #[ts(rename = "type")]
    pub kind: FileTreeNodeType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<Self>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct WorkspacePathItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub truncated: bool,
    #[ts(type = "number")]
    pub total_lines: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct ProjectInfo {
    #[serde(rename = "type")]
    #[ts(rename = "type")]
    pub project_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub framework: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_manager: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GlobResult {
    pub paths: Vec<String>,
    pub truncated: bool,
    #[ts(type = "number")]
    pub total: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GrepResult {
    pub lines: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct ProjectSnapshotResult {
    pub root_name: String,
    pub project_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_manager: Option<String>,
    pub scripts: std::collections::BTreeMap<String, String>,
    pub dependencies: std::collections::BTreeMap<String, String>,
    pub dev_dependencies: std::collections::BTreeMap<String, String>,
    pub config_files: Vec<String>,
    pub entrypoints: Vec<String>,
    pub tree: String,
    pub docs_tree: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct EditorInfo {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exe_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_data: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub head: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct GitSnapshotResult {
    pub snapshot: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct SessionImageAttachment {
    pub id: String,
    pub kind: String, // "image"
    pub name: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: u64,
    pub storage_key: String,
    pub scope: String, // "session"
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct DraftImageAttachment {
    pub id: String,
    pub kind: String, // "image"
    pub name: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: u64,
    pub storage_key: String,
    pub scope: String, // "draft"
    pub draft_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "scope")]
#[ts(export)]
pub enum ComposerImageAttachment {
    #[serde(rename = "session")]
    Session(SessionImageAttachment),
    #[serde(rename = "draft")]
    Draft(DraftImageAttachment),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct AttachmentPreviewBytes {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::{
        CommandError, DesktopEvent, ErrorCode, FileTreeNode, FileTreeNodeType, SystemProbeEvent,
        ThemeInfo, ThemeSource, WindowAction,
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
    fn workspace_tree_nodes_keep_legacy_type_and_optional_fields() {
        let node = FileTreeNode {
            name: "src".to_string(),
            path: "src".to_string(),
            kind: FileTreeNodeType::Directory,
            children: Some(Vec::new()),
            size: None,
            extension: None,
        };
        let value = serde_json::to_value(node).expect("workspace tree node must serialize");

        assert_eq!(value["type"], "directory");
        assert!(value.get("children").is_some());
        assert!(value.get("size").is_none() && value.get("extension").is_none());
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
