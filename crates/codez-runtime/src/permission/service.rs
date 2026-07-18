use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

use crate::permission::ai_classifier::{
    PermissionAiClassifier, PermissionAiContext, PermissionClassificationRequest,
    PermissionProjectInstruction,
};
use crate::permission::audit::{PermissionAuditError, PermissionAuditLog};
use crate::permission::contract::{
    PermissionAction, PermissionApprovalScope, PermissionCapability,
};
use crate::permission::decision::{
    PermissionCheck, PermissionDecisionEngine, PermissionDecisionInput, ToolApprovalPreference,
};
use crate::permission::shell::effects::{analyze_operation, unwrap_process_wrappers};
use crate::permission::shell::guard::{CriticalEnforcement, CriticalOperationGuard};
use crate::permission::shell::impact::PathImpactAnalyzer;
use crate::permission::shell::parser::ShellCommandParser;
use crate::permission::shell::policies::{classify_known_command, normalize_executable_name};
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
    ai_classifier: Option<Arc<dyn PermissionAiClassifier>>,
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
            ai_classifier: None,
        }
    }

    #[must_use]
    pub fn with_ai_classifier(mut self, classifier: Arc<dyn PermissionAiClassifier>) -> Self {
        self.ai_classifier = Some(classifier);
        self
    }

    /// Removes all in-memory permission rules owned by one session.
    pub async fn clear_session(&self, session_id: &str) {
        self.rules.clear_session(session_id).await;
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "permission authorization keeps policy, AI, and approval inputs explicit"
    )]
    pub async fn authorize(
        &self,
        prepared: &PreparedToolCall,
        workspace_root: &Path,
        session_id: Option<&str>,
        agent_role: &str,
        approval_preference: Option<ToolApprovalPreference>,
        ai_context: Option<&PermissionAiContext>,
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
                agent_role,
                mode.clone(),
                approval_preference.clone(),
                ai_context,
            )
            .await?;
        if checks.is_empty() || prepared.effects.analysis_status != "parsed" {
            let (fallback, _) = self
                .evaluate_check(
                    &canonical_workspace,
                    session_id,
                    mode.clone(),
                    approval_preference,
                    PermissionCapability::Unknown,
                    &prepared.canonical_name,
                    "The tool effect plan could not be completely classified.",
                    false,
                )
                .await?;
            checks.push(fallback);
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

    #[expect(
        clippy::too_many_arguments,
        reason = "effect evaluation keeps every policy and AI input explicit"
    )]
    async fn evaluate_effects(
        &self,
        prepared: &PreparedToolCall,
        workspace_root: &Path,
        session_id: Option<&str>,
        agent_role: &str,
        mode: crate::permission::decision::PermissionMode,
        approval_preference: Option<ToolApprovalPreference>,
        ai_context: Option<&PermissionAiContext>,
    ) -> Result<Vec<EvaluatedPermissionCheck>, PermissionStoreError> {
        let mut checks = Vec::new();
        for effect in &prepared.effects.effects {
            for classification in classify_effect(effect, workspace_root).await {
                let (mut check, explicit_rule) = self
                    .evaluate_check(
                        workspace_root,
                        session_id,
                        mode.clone(),
                        approval_preference.clone(),
                        classification.permission.clone(),
                        &classification.pattern,
                        &classification.reason,
                        classification.absolute_redline,
                    )
                    .await?;
                if classification.ai_eligible
                    && explicit_rule.is_none()
                    && mode == crate::permission::decision::PermissionMode::Auto
                    && approval_preference != Some(ToolApprovalPreference::User)
                    && check.action == PermissionAction::Ask
                    && let Some(classifier) = &self.ai_classifier
                    && let Some(request) = ai_classification_request(
                        prepared,
                        effect,
                        workspace_root,
                        session_id,
                        agent_role,
                        &classification,
                        ai_context,
                    )
                    .await
                {
                    let verdict = classifier.classify(&request).await;
                    if verdict.can_auto_allow() {
                        check.action = PermissionAction::Allow;
                        if let Some(reason) = verdict.reason() {
                            check.reason = format!("AI classifier: {reason}");
                        }
                    }
                }
                checks.push(check);
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
    ) -> Result<(EvaluatedPermissionCheck, Option<PermissionAction>), PermissionStoreError> {
        let explicit_rule = self
            .rules
            .resolve(workspace_root, session_id, &permission, pattern)
            .await?;
        let decision = PermissionDecisionEngine::decide(PermissionDecisionInput {
            mode,
            permission: permission.clone(),
            explicit_rule: explicit_rule.clone(),
            approval_preference,
            absolute_redline,
        });
        Ok((
            EvaluatedPermissionCheck {
                permission,
                pattern: pattern.to_string(),
                action: decision.action,
                reason: reason.to_string(),
                absolute_redline,
            },
            explicit_rule,
        ))
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
    ai_eligible: bool,
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
            ai_eligible: false,
        }
    }

    fn unknown_static(pattern: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            permission: PermissionCapability::ShellUnparsed,
            pattern: pattern.into(),
            reason: reason.into(),
            absolute_redline: false,
            ai_eligible: true,
        }
    }
}

const PROJECT_MARKERS: &[&str] = &[
    ".git",
    "Cargo.toml",
    "go.mod",
    "package.json",
    "pnpm-lock.yaml",
    "pyproject.toml",
    "requirements.txt",
    "pom.xml",
    "build.gradle",
    "settings.gradle",
    "gradlew",
    "yarn.lock",
];
const PROJECT_INSTRUCTION_PATHS: &[&str] = &["AGENTS.md", ".agents/AGENTS.md"];
const MAX_PROJECT_INSTRUCTION_BYTES: u64 = 16 * 1024;
const MAX_AI_USER_INTENT_BYTES: usize = 16 * 1024;

async fn ai_classification_request(
    prepared: &PreparedToolCall,
    effect: &ToolEffect,
    workspace_root: &Path,
    session_id: Option<&str>,
    agent_role: &str,
    classification: &EffectClassification,
    ai_context: Option<&PermissionAiContext>,
) -> Option<PermissionClassificationRequest> {
    let ToolEffect::ExecuteCommand {
        shell,
        command,
        cwd,
    } = effect
    else {
        return None;
    };
    let project_markers = project_markers(workspace_root).await;
    let project_instructions = project_instructions(workspace_root).await;
    Some(PermissionClassificationRequest {
        provider_id: ai_context.and_then(|context| context.provider_id.clone()),
        model: ai_context.and_then(|context| context.model.clone()),
        tool_name: prepared.canonical_name.clone(),
        shell: shell.clone(),
        command: command.clone(),
        operation: classification.pattern.clone(),
        workspace_root: workspace_root.to_string_lossy().to_string(),
        cwd: cwd
            .clone()
            .unwrap_or_else(|| workspace_root.to_string_lossy().to_string()),
        session_id: session_id.map(str::to_string),
        agent_role: agent_role.to_string(),
        user_intent: ai_context
            .and_then(|context| context.user_intent.as_deref())
            .map(|intent| bounded_utf8(intent, MAX_AI_USER_INTENT_BYTES)),
        project_markers,
        project_instructions,
    })
}

fn bounded_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

async fn project_markers(workspace_root: &Path) -> Vec<String> {
    let mut markers = Vec::new();
    for marker in PROJECT_MARKERS {
        if tokio::fs::try_exists(workspace_root.join(marker))
            .await
            .unwrap_or(false)
        {
            markers.push((*marker).to_string());
        }
    }
    markers
}

async fn project_instructions(workspace_root: &Path) -> Vec<PermissionProjectInstruction> {
    let mut instructions = Vec::new();
    let mut remaining = MAX_PROJECT_INSTRUCTION_BYTES;
    for relative in PROJECT_INSTRUCTION_PATHS {
        let path = workspace_root.join(relative);
        let Ok(canonical) = tokio::fs::canonicalize(&path).await else {
            continue;
        };
        if !canonical.starts_with(workspace_root) {
            continue;
        }
        let Ok(metadata) = tokio::fs::metadata(&canonical).await else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > remaining {
            continue;
        }
        let Ok(content) = tokio::fs::read_to_string(&canonical).await else {
            continue;
        };
        if content.len() as u64 > remaining {
            continue;
        }
        remaining = remaining.saturating_sub(content.len() as u64);
        instructions.push(PermissionProjectInstruction {
            path: (*relative).to_string(),
            content,
        });
    }
    instructions
}

async fn classify_effect(effect: &ToolEffect, workspace_root: &Path) -> Vec<EffectClassification> {
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
        ToolEffect::ExecuteCommand {
            shell,
            command,
            cwd,
        } => classify_command(shell, command, workspace_root, cwd.as_deref()).await,
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

async fn classify_command(
    shell: &str,
    command: &str,
    workspace_root: &Path,
    cwd: Option<&str>,
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
    let is_powershell = shell_kind == PermissionShellKind::Powershell;
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

    let cwd = cwd.unwrap_or_else(|| workspace_root.to_str().unwrap_or_default());
    let command_changes_cwd = graph.operations.iter().any(|operation| {
        matches!(
            normalize_executable_name(
                unwrap_process_wrappers(&operation.argv)
                    .first()
                    .map_or("", String::as_str)
            )
            .as_str(),
            "cd" | "set-location" | "sl"
        )
    });
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
        let generic_effects = analyze_operation(operation);
        if !generic_effects.incomplete_reasons.is_empty() {
            classifications.push(EffectClassification::new(
                PermissionCapability::ShellUnparsed,
                operation.source.clone(),
                generic_effects.incomplete_reasons.join(" "),
                false,
            ));
            continue;
        }
        if !generic_effects.unsafe_environment_keys.is_empty() {
            classifications.push(EffectClassification::new(
                PermissionCapability::ShellUnparsed,
                operation.source.clone(),
                format!(
                    "The command changes execution-affecting environment variables: {}.",
                    generic_effects.unsafe_environment_keys.join(", ")
                ),
                false,
            ));
            continue;
        }
        for path in generic_effects.read_paths {
            let permission = if command_changes_cwd && Path::new(&path).is_relative() {
                PermissionCapability::ExternalDirectory
            } else {
                classify_literal_shell_path(&path, workspace_root, cwd, PermissionCapability::Read)
                    .await
            };
            classifications.push(EffectClassification::new(
                permission,
                path,
                "Read a literal path through a shell command",
                false,
            ));
        }
        for path in generic_effects.write_paths {
            let permission = if command_changes_cwd && Path::new(&path).is_relative() {
                PermissionCapability::ExternalDirectory
            } else {
                classify_literal_shell_path(&path, workspace_root, cwd, PermissionCapability::Edit)
                    .await
            };
            classifications.push(EffectClassification::new(
                permission,
                path,
                "Write a path through a command output option or operand",
                false,
            ));
        }
        let arguments = unwrap_process_wrappers(&operation.argv);
        let Some(assessment) = classify_known_command(arguments) else {
            classifications.push(EffectClassification::unknown_static(
                operation.source.clone(),
                "The shell command is unknown or could not be completely classified.",
            ));
            continue;
        };
        let permission = if assessment.permission == PermissionCapability::Edit {
            classify_shell_write_scope(arguments, workspace_root, cwd).await
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
        if redirect.operator == "<"
            || is_powershell && redirect.target.eq_ignore_ascii_case("$null")
        {
            continue;
        }
        let permission = if command_changes_cwd && Path::new(&redirect.target).is_relative() {
            PermissionCapability::ExternalDirectory
        } else {
            classify_literal_shell_path(
                &redirect.target,
                workspace_root,
                cwd,
                PermissionCapability::Edit,
            )
            .await
        };
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

async fn classify_shell_write_scope(
    arguments: &[String],
    workspace_root: &Path,
    cwd: &str,
) -> PermissionCapability {
    for argument in arguments.iter().skip(1) {
        let candidate = argument.trim_matches(['\'', '"']);
        let path = PathBuf::from(candidate);
        if (path.is_absolute()
            || path
                .components()
                .any(|component| component == std::path::Component::ParentDir))
            && classify_literal_shell_path(
                candidate,
                workspace_root,
                cwd,
                PermissionCapability::Edit,
            )
            .await
                == PermissionCapability::ExternalDirectory
        {
            return PermissionCapability::ExternalDirectory;
        }
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
    let Some(target) = target else {
        return PermissionCapability::ExternalDirectory;
    };
    classify_literal_shell_path(target, workspace_root, cwd, PermissionCapability::Edit).await
}

async fn classify_literal_shell_path(
    target: &str,
    workspace_root: &Path,
    cwd: &str,
    inside_capability: PermissionCapability,
) -> PermissionCapability {
    let target = target.trim_matches(['\'', '"']);
    if target.is_empty() || target.contains(['$', '%', '*', '?']) {
        return PermissionCapability::ExternalDirectory;
    }
    let impact = PathImpactAnalyzer::analyze(target, &workspace_root.to_string_lossy(), cwd).await;
    if impact.inside_workspace && !impact.sensitive {
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

    use async_trait::async_trait;
    use codez_core::AtomicPersistence;
    use codez_storage::AtomicFileStore;

    use super::{
        EffectClassification, PermissionService, ai_classification_request, classify_effect,
    };
    use crate::permission::ai_classifier::{
        AiCommandCategory, PermissionAiClassifier, PermissionAiContext,
        PermissionClassificationRequest, PermissionClassifierVerdict,
    };
    use crate::permission::audit::PermissionAuditLog;
    use crate::permission::contract::PermissionCapability;
    use crate::permission::store::{PermissionRuleStore, WorkspacePermissionStore};
    use crate::tools::builtin::powershell::PowerShellTool;
    use crate::tools::types::{NormalizedToolCall, PreparedToolCall, ToolEffect, ToolEffectPlan};

    #[derive(Clone)]
    struct FixedAiClassifier(PermissionClassifierVerdict);

    #[async_trait]
    impl PermissionAiClassifier for FixedAiClassifier {
        async fn classify(
            &self,
            _request: &PermissionClassificationRequest,
        ) -> PermissionClassifierVerdict {
            self.0.clone()
        }
    }

    async fn authorize_in_auto_mode(effect: ToolEffect) -> bool {
        authorize_in_auto_mode_with_classifier(effect, None).await
    }

    async fn authorize_in_auto_mode_with_classifier(
        effect: ToolEffect,
        classifier: Option<Arc<dyn PermissionAiClassifier>>,
    ) -> bool {
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
        let service = if let Some(classifier) = classifier {
            service.with_ai_classifier(classifier)
        } else {
            service
        };
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
                None,
            )
            .await
            .expect("permission evaluation must succeed")
            .authorized
    }

    #[tokio::test]
    async fn ai_request_contains_bounded_user_and_workspace_context() {
        let workspace = tempfile::tempdir().expect("temporary workspace must be available");
        std::fs::write(
            workspace.path().join("Cargo.toml"),
            "[package]\nname = \"demo\"\n",
        )
        .expect("project marker must be written");
        std::fs::write(
            workspace.path().join("AGENTS.md"),
            "Run local verification before reporting completion.",
        )
        .expect("project instructions must be written");
        let canonical_workspace =
            std::fs::canonicalize(workspace.path()).expect("workspace must canonicalize");
        let command = "custom-build verify";
        let effect = ToolEffect::ExecuteCommand {
            shell: "powershell".to_string(),
            command: command.to_string(),
            cwd: Some(canonical_workspace.to_string_lossy().to_string()),
        };
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
                effects: vec![effect.clone()],
                analysis_status: "parsed".to_string(),
            },
            resource_keys: Vec::new(),
        };
        let context = PermissionAiContext {
            provider_id: Some("provider-1".to_string()),
            model: Some("model-1".to_string()),
            user_intent: Some("验证这个 Rust 项目".repeat(2_000)),
        };
        let request = ai_classification_request(
            &prepared,
            &effect,
            &canonical_workspace,
            Some("session-1"),
            "main",
            &EffectClassification::unknown_static(command, "unknown static command"),
            Some(&context),
        )
        .await
        .expect("shell command must produce an AI request");

        assert_eq!(request.provider_id.as_deref(), Some("provider-1"));
        assert_eq!(request.model.as_deref(), Some("model-1"));
        assert!(request.project_markers.contains(&"Cargo.toml".to_string()));
        assert_eq!(request.project_instructions[0].path, "AGENTS.md");
        assert!(
            request
                .user_intent
                .as_ref()
                .is_some_and(|intent| intent.len() <= super::MAX_AI_USER_INTENT_BYTES)
        );
    }

    #[tokio::test]
    async fn read_memory_is_not_classified_as_an_external_filesystem_path() {
        let workspace = std::path::Path::new("C:\\workspace");

        let classified = classify_effect(
            &ToolEffect::ReadMemory {
                path: "session:session-a:tool-results".to_string(),
            },
            workspace,
        )
        .await;

        assert_eq!(classified.len(), 1);
        assert_eq!(classified[0].permission, PermissionCapability::Read);
    }

    #[tokio::test]
    async fn internal_runtime_state_uses_the_read_only_permission_capability() {
        let workspace = std::path::Path::new("C:\\workspace");

        let classified = classify_effect(
            &ToolEffect::Internal {
                target: "session:session-a:tool-exposure".to_string(),
            },
            workspace,
        )
        .await;

        assert_eq!(classified[0].permission, PermissionCapability::Read);
    }

    #[tokio::test]
    async fn restricted_agent_spawn_uses_the_read_only_permission_capability() {
        let classified = classify_effect(
            &ToolEffect::SpawnAgent {
                role: "Explore".to_string(),
                isolation: Some("session".to_string()),
                read_only: true,
            },
            std::path::Path::new("C:\\workspace"),
        )
        .await;

        assert_eq!(classified[0].permission, PermissionCapability::Read);
    }

    #[tokio::test]
    async fn shell_enabled_agent_spawn_remains_an_external_effect() {
        let classified = classify_effect(
            &ToolEffect::SpawnAgent {
                role: "Explore".to_string(),
                isolation: Some("session".to_string()),
                read_only: false,
            },
            std::path::Path::new("C:\\workspace"),
        )
        .await;

        assert_eq!(
            classified[0].permission,
            PermissionCapability::ExternalEffect
        );
    }

    #[tokio::test]
    async fn cargo_clippy_is_fully_classified() {
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command: "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings".to_string(),
                cwd: None,
            },
            std::path::Path::new("C:\\workspace"),
        )
        .await;

        assert!(
            !classified.is_empty()
                && classified
                    .iter()
                    .all(|item| item.permission == PermissionCapability::Shell)
        );
    }

    #[tokio::test]
    async fn compound_read_only_git_commands_are_fully_classified() {
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command: "git status --short; git log -5 --oneline --decorate".to_string(),
                cwd: None,
            },
            std::path::Path::new("C:\\workspace"),
        )
        .await;

        assert!(
            classified.len() == 2
                && classified
                    .iter()
                    .all(|item| item.permission == PermissionCapability::Shell)
        );
    }

    #[tokio::test]
    async fn powershell_read_pipeline_is_fully_classified() {
        let workspace = tempfile::tempdir().expect("workspace must exist");
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command: "Get-ChildItem -Recurse src,src-tauri/src,src-tauri/tests -File | Select-Object FullName,Length | Format-Table -AutoSize".to_string(),
                cwd: None,
            },
            workspace.path(),
        )
        .await;

        assert!(
            classified.len() >= 3
                && classified.iter().all(|item| {
                    matches!(
                        item.permission,
                        PermissionCapability::Read | PermissionCapability::Shell
                    )
                }),
            "unexpected classifications: {classified:?}"
        );
    }

    #[tokio::test]
    async fn powershell_read_control_flow_is_fully_classified() {
        let workspace = tempfile::tempdir().expect("workspace must exist");
        let command = r#"$patterns = @('README*','.github/**/*','scripts/**/*','docs/testing/**/*','src/**/*.css','src/**/*.scss'); foreach ($pattern in $patterns) { "===== $pattern ====="; $matches = @(Get-ChildItem -Path $pattern -File -Recurse -ErrorAction SilentlyContinue); if ($matches.Count -eq 0) { '(none)' } else { $matches | ForEach-Object { $_.FullName.Substring((Get-Location).Path.Length + 1) } } }; "===== root ====="; Get-ChildItem -Force | Select-Object Mode,Name | Format-Table -AutoSize"#;
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command: command.to_string(),
                cwd: None,
            },
            workspace.path(),
        )
        .await;

        assert!(
            !classified.is_empty()
                && classified.iter().all(|item| {
                    matches!(
                        item.permission,
                        PermissionCapability::Read | PermissionCapability::Shell
                    )
                }),
            "unexpected classifications: {classified:?}"
        );
    }

    #[tokio::test]
    async fn powershell_null_redirection_does_not_create_a_file_write_effect() {
        let workspace = tempfile::tempdir().expect("workspace must exist");
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command: "git status > $null".to_string(),
                cwd: Some(workspace.path().to_string_lossy().to_string()),
            },
            workspace.path(),
        )
        .await;

        assert!(
            !classified.is_empty()
                && classified
                    .iter()
                    .all(|item| item.permission == PermissionCapability::Shell),
            "unexpected classifications: {classified:?}"
        );
    }

    #[tokio::test]
    async fn mixed_compound_commands_preserve_the_riskiest_operation() {
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command: "git status; npm install react".to_string(),
                cwd: None,
            },
            std::path::Path::new("C:\\workspace"),
        )
        .await;

        assert!(
            classified
                .iter()
                .any(|item| item.permission == PermissionCapability::Network)
        );
    }

    #[tokio::test]
    async fn compound_commands_do_not_hide_delete_operations() {
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command: "Get-ChildItem src; Remove-Item -Recurse generated".to_string(),
                cwd: None,
            },
            std::path::Path::new("C:\\workspace"),
        )
        .await;

        assert!(
            classified
                .iter()
                .any(|item| item.permission == PermissionCapability::Delete)
        );
    }

    #[tokio::test]
    async fn output_redirection_to_an_external_path_fails_closed() {
        let external = std::env::temp_dir().join("codez-external-output.txt");
        let command = format!("Get-Content README.md > '{}'", external.to_string_lossy());
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command,
                cwd: None,
            },
            std::path::Path::new("C:\\workspace"),
        )
        .await;

        assert!(
            classified
                .iter()
                .any(|item| item.permission == PermissionCapability::ExternalDirectory)
        );
    }

    #[tokio::test]
    async fn dynamic_powershell_invocations_fail_closed() {
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command: "& $command --flag".to_string(),
                cwd: None,
            },
            std::path::Path::new("C:\\workspace"),
        )
        .await;

        assert!(
            classified
                .iter()
                .any(|item| item.permission == PermissionCapability::ShellUnparsed)
        );
    }

    #[tokio::test]
    async fn execution_affecting_environment_fails_closed_before_command_allowlists() {
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "bash".to_string(),
                command: "LD_PRELOAD=/tmp/inject.so ls".to_string(),
                cwd: None,
            },
            std::path::Path::new("C:\\workspace"),
        )
        .await;

        assert!(classified.iter().any(|item| {
            item.permission == PermissionCapability::ShellUnparsed && !item.ai_eligible
        }));
    }

    #[tokio::test]
    async fn command_output_option_to_external_path_fails_closed() {
        let workspace = tempfile::tempdir().expect("workspace must exist");
        let external = tempfile::tempdir().expect("external directory must exist");
        let output = external.path().join("sorted.txt");
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "bash".to_string(),
                command: format!("sort input.txt -o '{}'", output.to_string_lossy()),
                cwd: Some(workspace.path().to_string_lossy().to_string()),
            },
            workspace.path(),
        )
        .await;

        assert!(
            classified
                .iter()
                .any(|item| item.permission == PermissionCapability::ExternalDirectory)
        );
    }

    #[tokio::test]
    async fn read_command_targeting_external_literal_path_fails_closed() {
        let workspace = tempfile::tempdir().expect("workspace must exist");
        let external = tempfile::NamedTempFile::new().expect("external file must exist");
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command: format!("Get-Content '{}'", external.path().to_string_lossy()),
                cwd: Some(workspace.path().to_string_lossy().to_string()),
            },
            workspace.path(),
        )
        .await;

        assert!(
            classified
                .iter()
                .any(|item| item.permission == PermissionCapability::ExternalDirectory)
        );
    }

    #[tokio::test]
    async fn destructive_git_branch_delete_requires_approval() {
        let classified = classify_effect(
            &ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command: "git branch -D obsolete".to_string(),
                cwd: None,
            },
            std::path::Path::new("C:\\workspace"),
        )
        .await;

        assert!(
            classified
                .iter()
                .any(|item| item.permission == PermissionCapability::Delete)
        );
    }

    #[tokio::test]
    async fn high_confidence_ai_local_build_can_allow_unknown_static_command() {
        let classifier: Arc<dyn PermissionAiClassifier> =
            Arc::new(FixedAiClassifier(PermissionClassifierVerdict::Allow {
                category: AiCommandCategory::LocalBuild,
                confidence_percent: 95,
                reason: "matches the requested local verification".to_string(),
            }));
        let authorized = authorize_in_auto_mode_with_classifier(
            ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command: "company-build-tool verify --workspace app".to_string(),
                cwd: None,
            },
            Some(classifier),
        )
        .await;

        assert!(authorized);
    }

    #[tokio::test]
    async fn ai_block_does_not_allow_unknown_static_command() {
        let classifier: Arc<dyn PermissionAiClassifier> =
            Arc::new(FixedAiClassifier(PermissionClassifierVerdict::Block {
                reason: "cannot prove this is local".to_string(),
            }));
        let authorized = authorize_in_auto_mode_with_classifier(
            ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command: "company-deploy production --force".to_string(),
                cwd: None,
            },
            Some(classifier),
        )
        .await;

        assert!(!authorized);
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
                    cwd: None,
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
