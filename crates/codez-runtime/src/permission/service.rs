use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

use crate::permission::audit::{PermissionAuditError, PermissionAuditLog};
use crate::permission::contract::{
    PermissionAction, PermissionApprovalScope, PermissionCapability,
};
use crate::permission::decision::{
    PermissionCheck, PermissionDecisionEngine, PermissionDecisionInput, ToolApprovalPreference,
};
use crate::permission::shell::guard::{CriticalEnforcement, CriticalOperationGuard};
use crate::permission::shell::policies::classify_known_command;
use crate::permission::store::{
    PermissionRuleStore, PermissionStoreError, RememberPermissionRuleInput,
    WorkspacePermissionStore,
};
use crate::tools::pipeline::ToolAuthorizationDecision;
use crate::tools::types::{PreparedToolCall, ToolEffect, ToolExecutionError};

#[derive(Debug, Error)]
pub enum PermissionServiceError {
    #[error(transparent)]
    Store(#[from] PermissionStoreError),
    #[error(transparent)]
    Audit(#[from] PermissionAuditError),
    #[error("permission approval failed")]
    Approval(#[source] Box<dyn std::error::Error + Send + Sync>),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionApprovalRequest {
    pub id: String,
    pub session_id: Option<String>,
    pub agent_role: String,
    pub tool_name: String,
    pub description: String,
    pub input: Value,
    pub checks: Vec<EvaluatedPermissionCheck>,
    pub allowed_scopes: Vec<PermissionApprovalScope>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionApprovalResponse {
    pub approved: bool,
    pub scope: PermissionApprovalScope,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluatedPermissionCheck {
    pub permission: PermissionCapability,
    pub pattern: String,
    pub action: PermissionAction,
    pub reason: String,
    pub absolute_redline: bool,
}

#[async_trait]
pub trait PermissionApprovalHandler: Send + Sync {
    async fn request(
        &self,
        request: &PermissionApprovalRequest,
    ) -> Result<PermissionApprovalResponse, Box<dyn std::error::Error + Send + Sync>>;
}

#[derive(Clone)]
pub struct PermissionService {
    modes: Arc<WorkspacePermissionStore>,
    rules: Arc<PermissionRuleStore>,
    audit: Arc<PermissionAuditLog>,
}

impl PermissionService {
    #[must_use]
    pub fn new(
        modes: Arc<WorkspacePermissionStore>,
        rules: Arc<PermissionRuleStore>,
        audit: Arc<PermissionAuditLog>,
    ) -> Self {
        Self {
            modes,
            rules,
            audit,
        }
    }

    /// Removes all in-memory permission rules owned by one session.
    pub async fn clear_session(&self, session_id: &str) {
        self.rules.clear_session(session_id).await;
    }

    pub async fn authorize(
        &self,
        prepared: &PreparedToolCall,
        workspace_root: &Path,
        session_id: Option<&str>,
        agent_role: &str,
        approval_preference: Option<ToolApprovalPreference>,
        approval_handler: Option<&dyn PermissionApprovalHandler>,
    ) -> Result<ToolAuthorizationDecision, PermissionServiceError> {
        let canonical_workspace = tokio::fs::canonicalize(workspace_root)
            .await
            .map_err(|_| PermissionStoreError::InvalidWorkspace)?;
        if !canonical_workspace.is_dir() {
            return Err(PermissionStoreError::InvalidWorkspace.into());
        }
        let mode = self.modes.get_mode(&canonical_workspace).await?;
        let mut checks = self
            .evaluate_effects(
                prepared,
                &canonical_workspace,
                session_id,
                mode.clone(),
                approval_preference.clone(),
            )
            .await?;
        if checks.is_empty() || prepared.effects.analysis_status != "parsed" {
            checks.push(
                self.evaluate_check(
                    &canonical_workspace,
                    session_id,
                    mode.clone(),
                    approval_preference,
                    PermissionCapability::Unknown,
                    &prepared.canonical_name,
                    "The tool effect plan could not be completely classified.",
                    false,
                )
                .await?,
            );
        }
        let action = PermissionDecisionEngine::aggregate(
            &checks
                .iter()
                .map(|check| PermissionCheck {
                    action: check.action.clone(),
                })
                .collect::<Vec<_>>(),
        );
        let request_id = Uuid::new_v4().to_string();
        self.audit
            .append(serde_json::json!({
                "event": "permission.evaluated",
                "requestId": request_id,
                "sessionId": session_id,
                "agentRole": agent_role,
                "toolName": prepared.canonical_name,
                "mode": mode,
                "action": action,
                "checks": checks,
            }))
            .await?;

        match action {
            PermissionAction::Allow => Ok(allowed_decision(request_id, &mode)),
            PermissionAction::Deny => Ok(denied_decision(
                "TOOL_DENIED",
                "Tool execution was denied by an explicit permission rule.",
                request_id,
                &mode,
            )),
            PermissionAction::Ask => {
                let Some(handler) = approval_handler else {
                    return Ok(denied_decision(
                        "TOOL_APPROVAL_REQUIRED",
                        "Tool execution requires explicit approval, but no approval handler is registered.",
                        request_id,
                        &mode,
                    ));
                };
                let absolute_redline = checks.iter().any(|check| check.absolute_redline);
                let request = PermissionApprovalRequest {
                    id: request_id.clone(),
                    session_id: session_id.map(str::to_string),
                    agent_role: agent_role.to_string(),
                    tool_name: prepared.canonical_name.clone(),
                    description: checks
                        .iter()
                        .filter(|check| check.action == PermissionAction::Ask)
                        .map(|check| check.reason.as_str())
                        .collect::<Vec<_>>()
                        .join("; "),
                    input: prepared.input.clone(),
                    checks: checks.clone(),
                    allowed_scopes: if absolute_redline {
                        vec![PermissionApprovalScope::Once]
                    } else {
                        vec![
                            PermissionApprovalScope::Once,
                            PermissionApprovalScope::Session,
                            PermissionApprovalScope::Workspace,
                        ]
                    },
                };
                let response = handler
                    .request(&request)
                    .await
                    .map_err(PermissionServiceError::Approval)?;
                let scope_allowed = request.allowed_scopes.contains(&response.scope);
                let approved = response.approved && scope_allowed;
                self.audit
                    .append(serde_json::json!({
                        "event": "permission.approval_resolved",
                        "requestId": request_id,
                        "sessionId": session_id,
                        "toolName": prepared.canonical_name,
                        "approved": approved,
                        "scope": response.scope,
                    }))
                    .await?;
                if !approved {
                    return Ok(denied_decision(
                        "TOOL_APPROVAL_DENIED",
                        if response.approved {
                            "The requested approval scope is not allowed for this operation."
                        } else {
                            "The user denied permission for this operation."
                        },
                        request_id,
                        &mode,
                    ));
                }
                if response.scope != PermissionApprovalScope::Once {
                    self.remember_approval(
                        &canonical_workspace,
                        session_id,
                        response.scope,
                        &checks,
                    )
                    .await?;
                }
                Ok(allowed_decision(request_id, &mode))
            }
        }
    }

    async fn evaluate_effects(
        &self,
        prepared: &PreparedToolCall,
        workspace_root: &Path,
        session_id: Option<&str>,
        mode: crate::permission::decision::PermissionMode,
        approval_preference: Option<ToolApprovalPreference>,
    ) -> Result<Vec<EvaluatedPermissionCheck>, PermissionStoreError> {
        let mut checks = Vec::new();
        for effect in &prepared.effects.effects {
            let (permission, pattern, reason, absolute_redline) =
                classify_effect(effect, workspace_root);
            checks.push(
                self.evaluate_check(
                    workspace_root,
                    session_id,
                    mode.clone(),
                    approval_preference.clone(),
                    permission,
                    &pattern,
                    &reason,
                    absolute_redline,
                )
                .await?,
            );
        }
        Ok(checks)
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "permission decisions require every policy input explicitly"
    )]
    async fn evaluate_check(
        &self,
        workspace_root: &Path,
        session_id: Option<&str>,
        mode: crate::permission::decision::PermissionMode,
        approval_preference: Option<ToolApprovalPreference>,
        permission: PermissionCapability,
        pattern: &str,
        reason: &str,
        absolute_redline: bool,
    ) -> Result<EvaluatedPermissionCheck, PermissionStoreError> {
        let explicit_rule = self
            .rules
            .resolve(workspace_root, session_id, &permission, pattern)
            .await?;
        let decision = PermissionDecisionEngine::decide(PermissionDecisionInput {
            mode,
            permission: permission.clone(),
            explicit_rule,
            approval_preference,
            absolute_redline,
        });
        Ok(EvaluatedPermissionCheck {
            permission,
            pattern: pattern.to_string(),
            action: decision.action,
            reason: reason.to_string(),
            absolute_redline,
        })
    }

    async fn remember_approval(
        &self,
        workspace_root: &Path,
        session_id: Option<&str>,
        scope: PermissionApprovalScope,
        checks: &[EvaluatedPermissionCheck],
    ) -> Result<(), PermissionStoreError> {
        for check in checks
            .iter()
            .filter(|check| check.action == PermissionAction::Ask && !check.absolute_redline)
        {
            self.rules
                .remember(RememberPermissionRuleInput {
                    workspace_root: workspace_root.to_path_buf(),
                    session_id: session_id.map(str::to_string),
                    permission: check.permission.clone(),
                    pattern: check.pattern.clone(),
                    action: PermissionAction::Allow,
                    scope: scope.clone(),
                    hardline: check.permission == PermissionCapability::Hardline,
                })
                .await?;
        }
        Ok(())
    }
}

fn classify_effect(
    effect: &ToolEffect,
    workspace_root: &Path,
) -> (PermissionCapability, String, String, bool) {
    match effect {
        ToolEffect::ReadFile { path, .. } | ToolEffect::ReadMemory { path } => classify_path(
            path,
            workspace_root,
            PermissionCapability::Read,
            "Read a file",
        ),
        ToolEffect::WriteFile { path, .. } => classify_path(
            path,
            workspace_root,
            PermissionCapability::Edit,
            "Modify a file",
        ),
        ToolEffect::DeleteFile { path } => classify_path(
            path,
            workspace_root,
            PermissionCapability::Delete,
            "Delete a file",
        ),
        ToolEffect::ExecuteCommand { command, .. } => classify_command(command),
        ToolEffect::Network { target, .. } => (
            PermissionCapability::Network,
            target.clone().unwrap_or_else(|| "network:*".to_string()),
            "Access the network".to_string(),
            false,
        ),
        ToolEffect::Rollback { target } => (
            PermissionCapability::Rollback,
            target.clone(),
            "Roll back a previous mutation".to_string(),
            false,
        ),
        ToolEffect::ExternalEffect { target }
        | ToolEffect::NotifyUser { channel: target }
        | ToolEffect::ControlExecution {
            execution_id: target,
            ..
        }
        | ToolEffect::Internal { target }
        | ToolEffect::Unknown { target } => (
            if matches!(effect, ToolEffect::Unknown { .. }) {
                PermissionCapability::Unknown
            } else {
                PermissionCapability::ExternalEffect
            },
            target.clone(),
            "Perform an external or unclassified effect".to_string(),
            false,
        ),
        ToolEffect::SpawnAgent { role, .. } => (
            PermissionCapability::ExternalEffect,
            role.clone(),
            "Spawn another agent".to_string(),
            false,
        ),
        ToolEffect::MutateTaskState { session_id } => (
            PermissionCapability::Edit,
            session_id
                .clone()
                .unwrap_or_else(|| "task-state".to_string()),
            "Modify task state".to_string(),
            false,
        ),
        ToolEffect::UserInteraction { channel } => (
            PermissionCapability::ExternalEffect,
            channel.clone(),
            "Request user interaction".to_string(),
            false,
        ),
    }
}

fn classify_path(
    path: &str,
    workspace_root: &Path,
    inside_capability: PermissionCapability,
    reason: &str,
) -> (PermissionCapability, String, String, bool) {
    let target = PathBuf::from(path);
    let inside_workspace = target.is_absolute() && target.starts_with(workspace_root);
    let sensitive = is_sensitive_path(&target);
    if inside_workspace && !sensitive {
        (
            inside_capability,
            path.to_string(),
            reason.to_string(),
            false,
        )
    } else {
        (
            PermissionCapability::ExternalDirectory,
            path.to_string(),
            format!("{reason} outside the verified workspace or in a sensitive location"),
            true,
        )
    }
}

fn classify_command(command: &str) -> (PermissionCapability, String, String, bool) {
    if let Some(finding) = CriticalOperationGuard::scan_raw(command) {
        let absolute = finding.enforcement == CriticalEnforcement::AbsoluteRedline;
        return (
            finding.permission,
            command.to_string(),
            finding.reason,
            absolute,
        );
    }
    if command
        .chars()
        .any(|character| matches!(character, ';' | '&' | '|' | '>' | '<' | '\n' | '\r'))
    {
        return (
            PermissionCapability::ShellUnparsed,
            command.to_string(),
            "The compound shell command requires explicit approval.".to_string(),
            false,
        );
    }
    let argv = command
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    classify_known_command(&argv).map_or_else(
        || {
            (
                PermissionCapability::ShellUnparsed,
                command.to_string(),
                "The shell command is unknown or could not be completely parsed.".to_string(),
                false,
            )
        },
        |assessment| {
            let absolute = assessment.permission == PermissionCapability::Hardline;
            (
                assessment.permission,
                command.to_string(),
                assessment.reason,
                absolute,
            )
        },
    )
}

fn is_sensitive_path(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/").to_lowercase();
    [
        "/.ssh/",
        "/.aws/",
        "/.npmrc",
        "/.netrc",
        "/permission-rules.json",
        "/workspace-permissions.json",
    ]
    .iter()
    .any(|segment| normalized.contains(segment))
}

fn allowed_decision(
    request_id: String,
    mode: &crate::permission::decision::PermissionMode,
) -> ToolAuthorizationDecision {
    let mut decision = ToolAuthorizationDecision::allow(request_id);
    decision.permission_mode = Some(mode_name(mode).to_string());
    decision
}

fn denied_decision(
    code: &str,
    message: &str,
    request_id: String,
    mode: &crate::permission::decision::PermissionMode,
) -> ToolAuthorizationDecision {
    let mut decision = ToolAuthorizationDecision::deny(ToolExecutionError {
        code: code.to_string(),
        message: message.to_string(),
        recoverable: false,
        suggestion: None,
        retry_after_ms: None,
        details: None,
    });
    decision.request_id = Some(request_id);
    decision.permission_mode = Some(mode_name(mode).to_string());
    decision
}

fn mode_name(mode: &crate::permission::decision::PermissionMode) -> &'static str {
    match mode {
        crate::permission::decision::PermissionMode::Auto => "auto",
        crate::permission::decision::PermissionMode::FullAccess => "full-access",
    }
}
