use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionCapability {
    Read,
    Edit,
    Shell,
    ShellUnparsed,
    Network,
    ExternalEffect,
    ExternalDirectory,
    Delete,
    Rollback,
    Unknown,
    Hardline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionAction {
    Allow,
    Deny,
    Ask,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionApprovalScope {
    Once,
    Session,
    Workspace,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecision {
    pub action: PermissionAction,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub workspace_root: String,
    pub session_id: Option<String>,
    pub capability: PermissionCapability,
    pub pattern: String,
    pub description: String,
}
