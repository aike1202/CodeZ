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
use crate::permission::shell::parser::ShellCommandParser;
use crate::permission::shell::policies::classify_known_command;
use crate::permission::shell::types::PermissionShellKind;
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
            for classification in classify_effect(effect, workspace_root) {
                checks.push(
                    self.evaluate_check(
                        workspace_root,
                        session_id,
                        mode.clone(),
                        approval_preference.clone(),
                        classification.permission,
                        &classification.pattern,
                        &classification.reason,
                        classification.absolute_redline,
                    )
                    .await?,
                );
            }
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

#[derive(Debug, PartialEq, Eq)]
struct EffectClassification {
    permission: PermissionCapability,
    pattern: String,
    reason: String,
    absolute_redline: bool,
}

impl EffectClassification {
    fn new(
        permission: PermissionCapability,
        pattern: impl Into<String>,
        reason: impl Into<String>,
        absolute_redline: bool,
    ) -> Self {
        Self {
            permission,
            pattern: pattern.into(),
            reason: reason.into(),
            absolute_redline,
        }
    }
}

fn classify_effect(effect: &ToolEffect, workspace_root: &Path) -> Vec<EffectClassification> {
    match effect {
        ToolEffect::ReadFile { path, .. } => vec![classify_path(
            path,
            workspace_root,
            PermissionCapability::Read,
            "Read a file",
        )],
        ToolEffect::ReadMemory { path } => vec![EffectClassification::new(
            PermissionCapability::Read,
            path.clone(),
            "Read session-scoped application memory",
            false,
        )],
        ToolEffect::WriteFile { path, .. } => vec![classify_path(
            path,
            workspace_root,
            PermissionCapability::Edit,
            "Modify a file",
        )],
        ToolEffect::DeleteFile { path } => vec![classify_path(
            path,
            workspace_root,
            PermissionCapability::Delete,
            "Delete a file",
        )],
        ToolEffect::ExecuteCommand { shell, command } => {
            classify_command(shell, command, workspace_root)
        }
        ToolEffect::Network { target, .. } => vec![EffectClassification::new(
            PermissionCapability::Network,
            target.clone().unwrap_or_else(|| "network:*".to_string()),
            "Access the network",
            false,
        )],
        ToolEffect::Rollback { target } => vec![EffectClassification::new(
            PermissionCapability::Rollback,
            target.clone(),
            "Roll back a previous mutation",
            false,
        )],
        ToolEffect::Internal { target } => vec![EffectClassification::new(
            PermissionCapability::Read,
            target.clone(),
            "Use session-scoped internal runtime state",
            false,
        )],
        ToolEffect::ExternalEffect { target }
        | ToolEffect::NotifyUser { channel: target }
        | ToolEffect::ControlExecution {
            execution_id: target,
            ..
        }
        | ToolEffect::Unknown { target } => vec![EffectClassification::new(
            if matches!(effect, ToolEffect::Unknown { .. }) {
                PermissionCapability::Unknown
            } else {
                PermissionCapability::ExternalEffect
            },
            target.clone(),
            "Perform an external or unclassified effect",
            false,
        )],
        ToolEffect::SpawnAgent {
            role, read_only, ..
        } => vec![EffectClassification::new(
            if *read_only {
                PermissionCapability::Read
            } else {
                PermissionCapability::ExternalEffect
            },
            format!("spawn-agent:{role}"),
            if *read_only {
                "Spawn a shell-disabled, read-only agent"
            } else {
                "Spawn an agent with shell or write capabilities"
            },
            false,
        )],
        ToolEffect::MutateTaskState { session_id } => vec![EffectClassification::new(
            PermissionCapability::Edit,
            session_id
                .clone()
                .unwrap_or_else(|| "task-state".to_string()),
            "Modify task state",
            false,
        )],
        ToolEffect::UserInteraction { channel } => vec![EffectClassification::new(
            PermissionCapability::ExternalEffect,
            channel.clone(),
            "Request user interaction",
            false,
        )],
    }
}

fn classify_path(
    path: &str,
    workspace_root: &Path,
    inside_capability: PermissionCapability,
    reason: &str,
) -> EffectClassification {
    let target = PathBuf::from(path);
    let inside_workspace = target.is_absolute() && target.starts_with(workspace_root);
    let sensitive = is_sensitive_path(&target);
    if inside_workspace && !sensitive {
        EffectClassification::new(inside_capability, path, reason, false)
    } else {
        EffectClassification::new(
            PermissionCapability::ExternalDirectory,
            path,
            format!("{reason} outside the verified workspace or in a sensitive location"),
            true,
        )
    }
}

fn classify_command(
    shell: &str,
    command: &str,
    workspace_root: &Path,
) -> Vec<EffectClassification> {
    if let Some(finding) = CriticalOperationGuard::scan_raw(command) {
        let absolute = finding.enforcement == CriticalEnforcement::AbsoluteRedline;
        return vec![EffectClassification::new(
            finding.permission,
            command,
            finding.reason,
            absolute,
        )];
    }

    let Some(shell_kind) = permission_shell_kind(shell) else {
        return vec![EffectClassification::new(
            PermissionCapability::ShellUnparsed,
            command,
            format!("The shell kind `{shell}` is not supported by the policy parser."),
            false,
        )];
    };
    let graph = ShellCommandParser::parse(shell_kind, command);
    if let Some(finding) = CriticalOperationGuard::scan_graph(&graph) {
        let absolute = finding.enforcement == CriticalEnforcement::AbsoluteRedline;
        return vec![EffectClassification::new(
            finding.permission,
            command,
            finding.reason,
            absolute,
        )];
    }

    let mut classifications = Vec::new();
    for operation in &graph.operations {
        if operation.dynamic {
            classifications.push(EffectClassification::new(
                PermissionCapability::ShellUnparsed,
                operation.source.clone(),
                "The command name or nested shell body is dynamic.",
                false,
            ));
            continue;
        }
        let Some(assessment) = classify_known_command(&operation.argv) else {
            classifications.push(EffectClassification::new(
                PermissionCapability::ShellUnparsed,
                operation.source.clone(),
                "The shell command is unknown or could not be completely classified.",
                false,
            ));
            continue;
        };
        let permission = if assessment.permission == PermissionCapability::Edit {
            classify_shell_write_scope(&operation.argv, workspace_root)
        } else {
            assessment.permission
        };
        let absolute = permission == PermissionCapability::Hardline;
        classifications.push(EffectClassification::new(
            permission,
            operation.source.clone(),
            assessment.reason,
            absolute,
        ));
    }

    for redirect in &graph.redirects {
        if redirect.operator == "<" {
            continue;
        }
        let permission = classify_literal_shell_path(
            &redirect.target,
            workspace_root,
            PermissionCapability::Edit,
        );
        classifications.push(EffectClassification::new(
            permission,
            redirect.target.clone(),
            "Write shell output through a redirection",
            false,
        ));
    }

    if !graph.diagnostics.is_empty() {
        classifications.push(EffectClassification::new(
            PermissionCapability::ShellUnparsed,
            command,
            format!(
                "The shell syntax could not be completely analyzed: {}",
                graph.diagnostics.join(", ")
            ),
            false,
        ));
    } else if graph.operations.is_empty() {
        classifications.push(EffectClassification::new(
            PermissionCapability::Shell,
            command,
            "Execute shell-local control flow or expressions",
            false,
        ));
    }
    classifications
}

fn permission_shell_kind(shell: &str) -> Option<PermissionShellKind> {
    match shell.to_ascii_lowercase().as_str() {
        "bash" | "sh" | "zsh" => Some(PermissionShellKind::Bash),
        "powershell" | "pwsh" => Some(PermissionShellKind::Powershell),
        "cmd" => Some(PermissionShellKind::Cmd),
        _ => None,
    }
}

fn classify_shell_write_scope(arguments: &[String], workspace_root: &Path) -> PermissionCapability {
    if arguments.iter().skip(1).any(|argument| {
        let candidate = argument.trim_matches(['\'', '"']);
        let path = PathBuf::from(candidate);
        (path.is_absolute()
            || path
                .components()
                .any(|component| component == std::path::Component::ParentDir))
            && classify_literal_shell_path(candidate, workspace_root, PermissionCapability::Edit)
                == PermissionCapability::ExternalDirectory
    }) {
        return PermissionCapability::ExternalDirectory;
    }
    let executable = crate::permission::shell::policies::normalize_executable_name(
        arguments.first().map_or("", String::as_str),
    );
    let path_parameters = ["-destination", "-filepath", "-literalpath", "-path"];
    let parameter_target = arguments.iter().enumerate().find_map(|(index, argument)| {
        path_parameters
            .contains(&argument.to_ascii_lowercase().as_str())
            .then(|| arguments.get(index + 1))
            .flatten()
    });
    let positional = arguments
        .iter()
        .skip(1)
        .filter(|argument| !argument.starts_with('-'))
        .collect::<Vec<_>>();
    let target = parameter_target.or_else(|| {
        if matches!(
            executable.as_str(),
            "copy-item" | "cp" | "move-item" | "mv" | "rename-item" | "ren"
        ) {
            positional.last().copied()
        } else {
            positional.first().copied()
        }
    });
    target.map_or(PermissionCapability::ExternalDirectory, |target| {
        classify_literal_shell_path(target, workspace_root, PermissionCapability::Edit)
    })
}

fn classify_literal_shell_path(
    target: &str,
    workspace_root: &Path,
    inside_capability: PermissionCapability,
) -> PermissionCapability {
    let target = target.trim_matches(['\'', '"']);
    if target.is_empty() || target.contains(['$', '%', '*', '?']) {
        return PermissionCapability::ExternalDirectory;
    }
    let requested = PathBuf::from(target);
    if !requested.is_absolute() {
        return if requested
            .components()
            .any(|component| component == std::path::Component::ParentDir)
        {
            PermissionCapability::ExternalDirectory
        } else {
            inside_capability
        };
    }
    let normalized_target = requested
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    let normalized_workspace = workspace_root
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase();
    if (normalized_target == normalized_workspace
        || normalized_target.starts_with(&format!("{normalized_workspace}/")))
        && !is_sensitive_path(&requested)
    {
        inside_capability
    } else {
        PermissionCapability::ExternalDirectory
    }
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use codez_core::AtomicPersistence;
    use codez_storage::AtomicFileStore;

    use super::{PermissionService, classify_effect};
    use crate::permission::audit::PermissionAuditLog;
    use crate::permission::contract::PermissionCapability;
    use crate::permission::store::{PermissionRuleStore, WorkspacePermissionStore};
    use crate::tools::builtin::powershell::PowerShellTool;
    use crate::tools::types::{NormalizedToolCall, PreparedToolCall, ToolEffect, ToolEffectPlan};

    async fn authorize_in_auto_mode(effect: ToolEffect) -> bool {
        let workspace = tempfile::tempdir().expect("temporary workspace must be available");
        let data = tempfile::tempdir().expect("temporary data root must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let modes = Arc::new(
            WorkspacePermissionStore::new(data.path(), Arc::clone(&persistence))
                .expect("mode store must be valid"),
        );
        let rules = Arc::new(
            PermissionRuleStore::new(data.path(), Arc::clone(&persistence))
                .expect("rule store must be valid"),
        );
        let audit = Arc::new(
            PermissionAuditLog::new(data.path(), persistence).expect("audit log must be valid"),
        );
        let service = PermissionService::new(modes, rules, audit);
        let prepared = PreparedToolCall {
            call: NormalizedToolCall {
                call_id: "call-1".to_string(),
                position: 0,
                name: "PowerShell".to_string(),
                raw_arguments: "{}".to_string(),
                thought_signature: None,
            },
            canonical_name: "PowerShell".to_string(),
            handler: Arc::new(PowerShellTool::new()),
            input: serde_json::json!({}),
            effects: ToolEffectPlan {
                effects: vec![effect],
                analysis_status: "parsed".to_string(),
            },
            resource_keys: Vec::new(),
        };

        service
            .authorize(
                &prepared,
                workspace.path(),
                Some("session-1"),
                "main",
                None,
                None,
            )
            .await
            .expect("permission evaluation must succeed")
            .authorized
    }

    #[test]
    fn read_memory_is_not_classified_as_an_external_filesystem_path() {
        let workspace = std::path::Path::new("C:\\workspace");

        let classified = classify_effect(
            &ToolEffect::ReadMemory {
                path: "session:session-a:tool-results".to_string(),
            },
            workspace,
        );

        assert_eq!(classified.len(), 1);
        assert_eq!(classified[0].permission, PermissionCapability::Read);
    }

    #[test]
    fn internal_runtime_state_uses_the_read_only_permission_capability() {
        let workspace = std::path::Path::new("C:\\workspace");

        let classified = classify_effect(
            &ToolEffect::Internal {
                target: "session:session-a:tool-exposure".to_string(),
            },
            workspace,
        );

        assert_eq!(classified[0].permission, PermissionCapability::Read);
    }

    #[test]
    fn restricted_agent_spawn_uses_the_read_only_permission_capability() {
        let classified = classify_effect(
            &ToolEffect::SpawnAgent {
                role: "Explore".to_string(),
                isolation: Some("session".to_string()),
                read_only: true,
            },
            std::path::Path::new("C:\\workspace"),
        );

        assert_eq!(classified[0].permission, PermissionCapability::Read);
    }

    #[test]
    fn shell_enabled_agent_spawn_remains_an_external_effect() {
        let classified = classify_effect(
            &ToolEffect::SpawnAgent {
                role: "Explore".to_string(),
                isolation: Some("session".to_string()),
                read_only: false,
            },
            std::path::Path::new("C:\\workspace"),
        );

        assert_eq!(
            classified[0].permission,
            PermissionCapability::ExternalEffect
        );
    }

    #[test]
    fn cargo_clippy_is_fully_classified() {
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command: "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings".to_string(),
            },
            std::path::Path::new("C:\\workspace"),
        );

        assert!(
            !classified.is_empty()
                && classified
                    .iter()
                    .all(|item| item.permission == PermissionCapability::Shell)
        );
    }

    #[test]
    fn compound_read_only_git_commands_are_fully_classified() {
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command: "git status --short; git log -5 --oneline --decorate".to_string(),
            },
            std::path::Path::new("C:\\workspace"),
        );

        assert!(
            classified.len() == 2
                && classified
                    .iter()
                    .all(|item| item.permission == PermissionCapability::Shell)
        );
    }

    #[test]
    fn powershell_read_pipeline_is_fully_classified() {
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command: "Get-ChildItem -Recurse src,src-tauri/src,src-tauri/tests -File | Select-Object FullName,Length | Format-Table -AutoSize".to_string(),
            },
            std::path::Path::new("C:\\workspace"),
        );

        assert!(
            classified.len() == 3
                && classified
                    .iter()
                    .all(|item| item.permission == PermissionCapability::Shell)
        );
    }

    #[test]
    fn powershell_read_control_flow_is_fully_classified() {
        let command = r#"$patterns = @('README*','.github/**/*','scripts/**/*','docs/testing/**/*','src/**/*.css','src/**/*.scss'); foreach ($pattern in $patterns) { "===== $pattern ====="; $matches = @(Get-ChildItem -Path $pattern -File -Recurse -ErrorAction SilentlyContinue); if ($matches.Count -eq 0) { '(none)' } else { $matches | ForEach-Object { $_.FullName.Substring((Get-Location).Path.Length + 1) } } }; "===== root ====="; Get-ChildItem -Force | Select-Object Mode,Name | Format-Table -AutoSize"#;
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command: command.to_string(),
            },
            std::path::Path::new("C:\\workspace"),
        );

        assert!(
            !classified.is_empty()
                && classified
                    .iter()
                    .all(|item| item.permission == PermissionCapability::Shell)
        );
    }

    #[test]
    fn mixed_compound_commands_preserve_the_riskiest_operation() {
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command: "git status; npm install react".to_string(),
            },
            std::path::Path::new("C:\\workspace"),
        );

        assert!(
            classified
                .iter()
                .any(|item| item.permission == PermissionCapability::Network)
        );
    }

    #[test]
    fn compound_commands_do_not_hide_delete_operations() {
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command: "Get-ChildItem src; Remove-Item -Recurse generated".to_string(),
            },
            std::path::Path::new("C:\\workspace"),
        );

        assert!(
            classified
                .iter()
                .any(|item| item.permission == PermissionCapability::Delete)
        );
    }

    #[test]
    fn output_redirection_to_an_external_path_fails_closed() {
        let external = std::env::temp_dir().join("codez-external-output.txt");
        let command = format!("Get-Content README.md > '{}'", external.to_string_lossy());
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command,
            },
            std::path::Path::new("C:\\workspace"),
        );

        assert!(
            classified
                .iter()
                .any(|item| item.permission == PermissionCapability::ExternalDirectory)
        );
    }

    #[test]
    fn dynamic_powershell_invocations_fail_closed() {
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command: "& $command --flag".to_string(),
            },
            std::path::Path::new("C:\\workspace"),
        );

        assert!(
            classified
                .iter()
                .any(|item| item.permission == PermissionCapability::ShellUnparsed)
        );
    }

    #[tokio::test]
    async fn auto_mode_authorizes_fully_classified_compound_reads_without_an_approval_handler() {
        for command in [
            "git status --short; git log -5 --oneline --decorate",
            "Get-ChildItem -Recurse src,src-tauri/src,src-tauri/tests -File | Select-Object FullName,Length | Format-Table -AutoSize",
        ] {
            assert!(
                authorize_in_auto_mode(ToolEffect::ExecuteCommand {
                    shell: "powershell".to_string(),
                    command: command.to_string(),
                })
                .await,
                "command should be authorized in auto mode: {command}"
            );
        }
    }

    #[tokio::test]
    async fn auto_mode_authorizes_a_machine_enforced_read_only_agent_spawn() {
        assert!(
            authorize_in_auto_mode(ToolEffect::SpawnAgent {
                role: "Explore".to_string(),
                isolation: Some("session".to_string()),
                read_only: true,
            })
            .await
        );
    }
}
