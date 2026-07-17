use std::{path::Path, sync::Arc};

use codez_core::{
    AppError, SessionId, WorkspaceRoot,
    context::{
        ContextScopeId, LedgerAppendRequest, LedgerEventType, SessionSkillState,
        SkillStateUpdatedPayload,
    },
};
use codez_runtime::{
    context::ledger::ModelLedgerStore,
    tools::{
        registry::{
            BoxFuture, DefaultToolDescriptor, ToolAvailability, ToolBehavior, ToolContext,
            ToolDescriptor, ToolHandler,
        },
        types::{
            ModelPreference, ToolApprovalMetadata, ToolConcurrency, ToolEffect, ToolEffectPlan,
            ToolExecutionError, ToolExecutionResult, ToolExposure, ToolInterruptBehavior,
            ToolPlanningContext, ToolSource,
        },
    },
};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::commands::skills::{SkillDefinition, SkillsService};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SkillToolKind {
    Legacy,
    Activate,
    Deactivate,
}

struct SkillSuccess {
    data: Value,
    model_content: String,
}

pub(crate) struct SkillTool {
    descriptor: DefaultToolDescriptor,
    kind: SkillToolKind,
    skills: Arc<SkillsService>,
    ledger: Arc<ModelLedgerStore>,
}

impl SkillTool {
    pub(crate) fn legacy(skills: Arc<SkillsService>, ledger: Arc<ModelLedgerStore>) -> Self {
        Self::new(
            SkillToolKind::Legacy,
            "Skill",
            "Invoke a skill by name.",
            "Load one available skill's trusted instructions into the current conversation. The ActivateSkill tool is preferred for persistent session state.",
            activate_schema(false),
            skills,
            ledger,
        )
    }

    pub(crate) fn activate(skills: Arc<SkillsService>, ledger: Arc<ModelLedgerStore>) -> Self {
        Self::new(
            SkillToolKind::Activate,
            "ActivateSkill",
            "Activate or refresh a session skill.",
            "Activate a skill for the current conversation and load its instructions. Active skills persist across turns, compaction, failures, and restart. A session-disabled skill requires force=true after an explicit user request.",
            activate_schema(true),
            skills,
            ledger,
        )
    }

    pub(crate) fn deactivate(skills: Arc<SkillsService>, ledger: Arc<ModelLedgerStore>) -> Self {
        Self::new(
            SkillToolKind::Deactivate,
            "DeactivateSkill",
            "Deactivate or session-disable a skill.",
            "Stop applying a skill in the current conversation. inactive permits later activation; disabled requires an explicit user request and force=true to reactivate.",
            deactivate_schema(),
            skills,
            ledger,
        )
    }

    fn new(
        kind: SkillToolKind,
        name: &'static str,
        summary: &str,
        description: &str,
        input_schema: Value,
        skills: Arc<SkillsService>,
        ledger: Arc<ModelLedgerStore>,
    ) -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name,
                version: "1.0.0",
                source: ToolSource::Builtin,
                source_id: format!("builtin:{}", name.to_ascii_lowercase()),
                summary: summary.to_string(),
                description: description.to_string(),
                input_schema,
                approval: ToolApprovalMetadata {
                    model_preference: ModelPreference::NotApplicable,
                },
                availability: ToolAvailability {
                    roles: None,
                    platforms: None,
                    exposure: ToolExposure::Core,
                },
                behavior: ToolBehavior {
                    concurrency: ToolConcurrency::ResourceLocked,
                    interrupt: ToolInterruptBehavior::Cancel,
                    max_result_chars: 1024 * 1024,
                    timeout_ms: Some(30_000),
                },
            },
            kind,
            skills,
            ledger,
        }
    }

    async fn run(
        &self,
        input: &Value,
        context: &ToolContext,
    ) -> Result<SkillSuccess, ToolExecutionError> {
        match self.kind {
            SkillToolKind::Legacy | SkillToolKind::Activate => {
                self.activate_skill(input, context).await
            }
            SkillToolKind::Deactivate => self.deactivate_skill(input, context).await,
        }
    }

    async fn activate_skill(
        &self,
        input: &Value,
        context: &ToolContext,
    ) -> Result<SkillSuccess, ToolExecutionError> {
        let requested = required_text(input, "skill")?;
        let force = self.kind == SkillToolKind::Activate
            && input.get("force").and_then(Value::as_bool).unwrap_or(false);
        let args = input
            .get("args")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let identity = runtime_identity(context)?;
        let workspace = WorkspaceRoot::from_canonical(context.workspace_root.clone())
            .map_err(|error| tool_error("SKILL_WORKSPACE_INVALID", error.to_string(), false))?;
        let catalog = self
            .skills
            .list(Some(&workspace))
            .await
            .map_err(|error| app_error("SKILL_CATALOG_FAILED", error))?;
        let skill = resolve_skill(&catalog, requested)?;
        if !skill.enabled {
            return Err(tool_error(
                "SKILL_NOT_AVAILABLE",
                format!("Skill '{}' is disabled in the skill catalog.", skill.name),
                false,
            ));
        }
        let content = skill_content(skill);
        let content_hash = content_hash(&content);
        let current = current_skill_state(&self.ledger, &identity, &skill.name).await?;
        if current
            .as_ref()
            .is_some_and(|state| state.status == "disabled")
            && !force
        {
            return Err(tool_error(
                "SKILL_DISABLED",
                format!(
                    "Skill '{}' is disabled for this conversation. Use force=true only after the user explicitly asks to re-enable it.",
                    skill.name
                ),
                false,
            ));
        }
        if !force
            && current.as_ref().is_some_and(|state| {
                state.status == "active"
                    && state.args.as_deref().unwrap_or_default() == args
                    && state.content_hash.as_deref() == Some(content_hash.as_str())
            })
        {
            let data = serde_json::json!({
                "type": "skill_state",
                "status": "already_active",
                "skill": skill.name,
                "contentHash": content_hash,
                "message": "Continue following the active skill content already present in this conversation."
            });
            return Ok(SkillSuccess {
                model_content: data.to_string(),
                data,
            });
        }
        append_skill_state(
            &self.ledger,
            context,
            &identity,
            SkillStateUpdatedPayload {
                name: skill.name.clone(),
                status: "active".to_string(),
                content: Some(content.clone()),
                content_hash: Some(content_hash),
                args: Some(args.clone()),
                source: "model".to_string(),
                reason: None,
            },
        )
        .await?;
        let model_content = [
            format!("<command-name>{}</command-name>", escape_tag(&skill.name)),
            format!("<command-args>{}</command-args>", escape_tag(&args)),
            content,
        ]
        .join("\n");
        Ok(SkillSuccess {
            data: serde_json::json!({
                "type": "skill_state",
                "status": "active",
                "skill": skill.name,
            }),
            model_content,
        })
    }

    async fn deactivate_skill(
        &self,
        input: &Value,
        context: &ToolContext,
    ) -> Result<SkillSuccess, ToolExecutionError> {
        let requested = required_text(input, "skill")?;
        let identity = runtime_identity(context)?;
        let current = current_skill_state(&self.ledger, &identity, requested).await?;
        let name = current
            .as_ref()
            .map_or_else(|| requested.to_string(), |state| state.name.clone());
        let status = if input.get("mode").and_then(Value::as_str) == Some("disabled") {
            "disabled"
        } else {
            "inactive"
        };
        let reason = input
            .get("reason")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|reason| !reason.is_empty())
            .map(str::to_string);
        if current.as_ref().is_some_and(|state| state.status == status) {
            let data = serde_json::json!({
                "type": "skill_state",
                "status": status,
                "skill": name,
                "reason": current.and_then(|state| state.reason),
                "message": format!("Skill is already {status} in this conversation.")
            });
            return Ok(SkillSuccess {
                model_content: data.to_string(),
                data,
            });
        }
        append_skill_state(
            &self.ledger,
            context,
            &identity,
            SkillStateUpdatedPayload {
                name: name.clone(),
                status: status.to_string(),
                content: None,
                content_hash: None,
                args: None,
                source: "model".to_string(),
                reason: reason.clone(),
            },
        )
        .await?;
        let data = serde_json::json!({
            "type": "skill_state",
            "status": status,
            "skill": name,
            "reason": reason,
            "message": if status == "disabled" {
                "Do not use this skill again unless the user explicitly asks to re-enable it."
            } else {
                "The skill may be activated later if a new request needs it."
            }
        });
        Ok(SkillSuccess {
            model_content: data.to_string(),
            data,
        })
    }
}

impl ToolHandler for SkillTool {
    fn descriptor(&self) -> &dyn ToolDescriptor {
        &self.descriptor
    }

    fn plan_effects<'a>(
        &'a self,
        _input: &'a Value,
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, ToolEffectPlan> {
        Box::pin(async move {
            ToolEffectPlan {
                effects: vec![ToolEffect::Internal {
                    target: skill_resource(context.session_id.as_deref()),
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
        Box::pin(async move { vec![skill_resource(context.session_id.as_deref())] })
    }

    fn execute<'a>(
        &'a self,
        input: &'a Value,
        context: &'a ToolContext,
    ) -> BoxFuture<'a, ToolExecutionResult> {
        Box::pin(async move {
            if context.cancellation.is_cancelled() {
                return ToolExecutionResult::Cancelled {
                    error: tool_error("TOOL_CANCELLED", "Skill operation was cancelled.", true),
                    model_content: None,
                    ui_content: None,
                    effects: None,
                };
            }
            match self.run(input, context).await {
                Ok(success) => ToolExecutionResult::Success {
                    data: Some(success.data),
                    model_content: success.model_content,
                    ui_content: None,
                    effects: Some(vec![ToolEffect::Internal {
                        target: skill_resource(context.session_id.as_deref()),
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

struct RuntimeIdentity {
    session_id: SessionId,
    context_scope_id: ContextScopeId,
}

fn runtime_identity(context: &ToolContext) -> Result<RuntimeIdentity, ToolExecutionError> {
    let session_id = context
        .session_id
        .as_deref()
        .ok_or_else(|| {
            tool_error(
                "TOOL_SESSION_REQUIRED",
                "Skill tools require an active session.",
                false,
            )
        })
        .and_then(|value| {
            SessionId::parse(value)
                .map_err(|error| tool_error("TOOL_SESSION_INVALID", error.to_string(), false))
        })?;
    let context_scope_id = ContextScopeId::parse(&context.context_scope_id)
        .map_err(|error| tool_error("CONTEXT_SCOPE_INVALID", error.to_string(), false))?;
    Ok(RuntimeIdentity {
        session_id,
        context_scope_id,
    })
}

async fn current_skill_state(
    ledger: &ModelLedgerStore,
    identity: &RuntimeIdentity,
    name: &str,
) -> Result<Option<SessionSkillState>, ToolExecutionError> {
    let snapshot = ledger
        .get_snapshot(&identity.session_id)
        .await
        .map_err(|error| app_error("SKILL_STATE_LOAD_FAILED", error.into()))?;
    Ok(snapshot.and_then(|snapshot| {
        snapshot
            .scopes
            .get(identity.context_scope_id.as_key().as_ref())
            .and_then(|scope| scope.skill_states.as_ref())
            .and_then(|states| states.iter().find(|state| state.name == name))
            .cloned()
    }))
}

async fn append_skill_state(
    ledger: &ModelLedgerStore,
    context: &ToolContext,
    identity: &RuntimeIdentity,
    payload: SkillStateUpdatedPayload,
) -> Result<(), ToolExecutionError> {
    let payload = serde_json::to_value(payload).map_err(|error| {
        tool_error(
            "SKILL_STATE_INVALID",
            format!("Skill state could not be serialized: {error}"),
            false,
        )
    })?;
    ledger
        .append_event_for(
            &identity.session_id,
            LedgerAppendRequest {
                event_id: format!(
                    "skill-state:{}:{}",
                    context.turn_id.as_deref().unwrap_or("unknown"),
                    context.call_id
                ),
                session_id: identity.session_id.as_str().to_string(),
                context_scope_id: identity.context_scope_id.clone(),
                turn_id: context.turn_id.clone(),
                created_at: chrono::Utc::now().to_rfc3339(),
                r#type: LedgerEventType::SkillStateUpdated,
                payload,
            },
        )
        .await
        .map_err(|error| app_error("SKILL_STATE_UPDATE_FAILED", error.into()))?;
    Ok(())
}

fn resolve_skill<'a>(
    catalog: &'a [SkillDefinition],
    requested: &str,
) -> Result<&'a SkillDefinition, ToolExecutionError> {
    if let Some(skill) = catalog.iter().find(|skill| skill.id == requested) {
        return Ok(skill);
    }
    let matches = catalog
        .iter()
        .filter(|skill| skill.name == requested)
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [skill] => Ok(skill),
        [] => {
            let available = catalog
                .iter()
                .filter(|skill| skill.enabled)
                .take(30)
                .map(|skill| format!("{} ({})", skill.name, skill.id))
                .collect::<Vec<_>>()
                .join(", ");
            Err(tool_error(
                "SKILL_NOT_FOUND",
                format!(
                    "Skill '{requested}' was not found. Available: {}",
                    if available.is_empty() {
                        "(none)"
                    } else {
                        &available
                    }
                ),
                false,
            ))
        }
        _ => Err(tool_error(
            "SKILL_NAME_AMBIGUOUS",
            format!("More than one skill is named '{requested}'; use its exact ID."),
            false,
        )),
    }
}

fn skill_content(skill: &SkillDefinition) -> String {
    let Some(directory) = Path::new(&skill.path).parent() else {
        return skill.content.clone();
    };
    format!(
        "{}\n\n---\n[Skill Location]: {}\nRead declared supporting files from this directory with workspace tools.",
        skill.content,
        directory.display()
    )
}

fn content_hash(content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn required_text<'a>(input: &'a Value, field: &str) -> Result<&'a str, ToolExecutionError> {
    input
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| tool_error("TOOL_INPUT_INVALID", format!("{field} is required."), false))
}

fn activate_schema(force: bool) -> Value {
    let mut properties = serde_json::json!({
        "skill": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256,
            "description": "Exact available skill name or ID."
        },
        "args": {
            "type": "string",
            "maxLength": 8192,
            "description": "Optional arguments for this activation."
        }
    });
    if force {
        properties["force"] = serde_json::json!({
            "type": "boolean",
            "description": "Refresh content or re-enable a session-disabled skill after an explicit user request."
        });
    }
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": properties,
        "required": ["skill"]
    })
}

fn deactivate_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "skill": { "type": "string", "minLength": 1, "maxLength": 256 },
            "mode": { "type": "string", "enum": ["inactive", "disabled"] },
            "reason": { "type": "string", "maxLength": 1024 }
        },
        "required": ["skill"]
    })
}

fn escape_tag(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn skill_resource(session_id: Option<&str>) -> String {
    format!("session:{}:skills", session_id.unwrap_or("unknown"))
}

fn app_error(code: &str, error: AppError) -> ToolExecutionError {
    tool_error(code, error.public_message(), error.retryable())
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
