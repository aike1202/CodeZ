use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionShellKind {
    Bash,
    Powershell,
    Cmd,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSnapshot {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedOperation {
    pub shell: PermissionShellKind,
    pub source: String,
    pub executable: String,
    pub argv: Vec<String>,
    pub dynamic: bool,
    pub children: Vec<NormalizedOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedRedirect {
    pub operator: String, // "<", ">", ">>"
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedOperationGraph {
    pub shell: PermissionShellKind,
    pub source: String,
    pub operations: Vec<NormalizedOperation>,
    pub operators: Vec<String>,
    pub redirects: Vec<NormalizedRedirect>,
    pub diagnostics: Vec<String>,
}
