use codez_core::{AppError, AppErrorKind};
use serde_json::Value;

use crate::tools::builtin::file_mutation::{
    abort_prepared_mutation, abort_staged_backup, ensure_authorized_path, prepare_mutation,
    read_state, reconcile_failed_write, record_successful_mutation, require_current_delivery,
    services, stage_backup, transaction_identity,
};
use crate::tools::builtin::path::{ToolPathError, resolve_tool_path};
use crate::tools::registry::{
    BoxFuture, DefaultToolDescriptor, ToolAvailability, ToolBehavior, ToolContext, ToolDescriptor,
    ToolHandler,
};
use crate::tools::types::{
    ModelPreference, ToolApprovalMetadata, ToolConcurrency, ToolEffect, ToolEffectPlan,
    ToolExecutionError, ToolExecutionResult, ToolExposure, ToolInterruptBehavior,
    ToolPlanningContext, ToolSource,
};

pub struct EditTool {
    descriptor: DefaultToolDescriptor,
}

impl EditTool {
    #[must_use]
    pub fn new() -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name: "Edit",
                version: "1.1.0",
                source: ToolSource::Builtin,
                source_id: "builtin:edit".to_string(),
                summary: "Make exact string replacements in a file.".to_string(),
                description: "Edits a bounded UTF-8 file after exact path authorization."
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "file_path": { "type": "string", "minLength": 1 },
                        "edits": {
                            "type": "array",
                            "minItems": 1,
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "properties": {
                                    "old_string": { "type": "string", "minLength": 1 },
                                    "new_string": { "type": "string" },
                                    "replace_all": { "type": "boolean" }
                                },
                                "required": ["old_string", "new_string"]
                            }
                        }
                    },
                    "required": ["file_path", "edits"]
                }),
                approval: ToolApprovalMetadata {
                    model_preference: ModelPreference::NotApplicable,
                },
                availability: ToolAvailability {
                    roles: None,
                    platforms: None,
                    exposure: ToolExposure::Always,
                },
                behavior: ToolBehavior {
                    concurrency: ToolConcurrency::ResourceLocked,
                    interrupt: ToolInterruptBehavior::Block,
                    max_result_chars: 100_000,
                    timeout_ms: None,
                },
            },
        }
    }
}

impl Default for EditTool {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolHandler for EditTool {
    fn descriptor(&self) -> &dyn ToolDescriptor {
        &self.descriptor
    }

    fn plan_effects<'a>(
        &'a self,
        input: &'a Value,
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, ToolEffectPlan> {
        Box::pin(async move {
            let Some(raw_path) = input.get("file_path").and_then(Value::as_str) else {
                return unparsed_plan("edit-path-missing");
            };
            resolve_tool_path(raw_path, &context.workspace_root)
                .await
                .map_or_else(
                    |_| unparsed_plan("edit-path-analysis"),
                    |resolved| ToolEffectPlan {
                        effects: vec![ToolEffect::WriteFile {
                            path: resolved.path.to_string_lossy().to_string(),
                            mode: "modify".to_string(),
                        }],
                        analysis_status: "parsed".to_string(),
                    },
                )
        })
    }

    fn resource_keys<'a>(
        &'a self,
        input: &'a Value,
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move {
            let Some(raw_path) = input.get("file_path").and_then(Value::as_str) else {
                return Vec::new();
            };
            resolve_tool_path(raw_path, &context.workspace_root)
                .await
                .map_or_else(
                    |_| Vec::new(),
                    |resolved| vec![format!("{}:write", resolved.path.to_string_lossy())],
                )
        })
    }

    fn execute<'a>(
        &'a self,
        arguments: &'a Value,
        context: &'a ToolContext,
    ) -> BoxFuture<'a, ToolExecutionResult> {
        Box::pin(async move {
            let Some(raw_path) = arguments.get("file_path").and_then(Value::as_str) else {
                return execution_error("TOOL_INPUT_INVALID", "file_path is required", true);
            };
            let Some(edits) = arguments.get("edits").and_then(Value::as_array) else {
                return execution_error("TOOL_INPUT_INVALID", "edits is required", true);
            };
            let resolved = match resolve_tool_path(raw_path, &context.workspace_root).await {
                Ok(resolved) => resolved,
                Err(error) => return path_error(error),
            };
            if !resolved.inside_workspace {
                return path_error(ToolPathError::OutsideWorkspace);
            }
            let approved = context.authorized_effects.effects.iter().any(|effect| {
                matches!(effect, ToolEffect::WriteFile { path, mode } if mode == "modify" && std::path::Path::new(path) == resolved.path)
            });
            if !approved {
                return path_error(ToolPathError::AuthorizationMismatch);
            }
            let services = match services(context) {
                Ok(services) => services,
                Err(error) => return app_error(error),
            };
            let (session_id, transaction_id) = match transaction_identity(context) {
                Ok(identity) => identity,
                Err(error) => return app_error(error),
            };
            let safe_path = match services
                .file_system
                .resolve(std::path::Path::new(raw_path))
                .await
            {
                Ok(path) => path,
                Err(error) => return app_error(error),
            };
            let absolute_path = safe_path.absolute_path();
            let operation = services
                .mutation_coordinator
                .run(
                    &absolute_path,
                    || async {
                        ensure_authorized_path(&resolved.path, &safe_path)?;
                        let before = read_state(services, &safe_path).await?;
                        let Some(original) = before.text()? else {
                            return Err(AppError::not_found(
                                "The file does not exist; use Write to create it",
                            ));
                        };
                        require_current_delivery(
                            services,
                            context,
                            session_id,
                            &absolute_path,
                            &before,
                        )?;
                        let updated = apply_edits(original, edits)?;
                        if updated.as_bytes() == original.as_bytes() {
                            return Err(AppError::validation(
                                "The edit batch produces no net change",
                            ));
                        }
                        let staged_backup =
                            stage_backup(services, transaction_id, &absolute_path, &before).await?;
                        let latest = match read_state(services, &safe_path).await {
                            Ok(latest) => latest,
                            Err(error) => {
                                return Err(abort_staged_backup(
                                    services,
                                    transaction_id,
                                    &absolute_path,
                                    staged_backup,
                                    error,
                                )
                                .await);
                            }
                        };
                        if latest != before {
                            return Err(
                                abort_staged_backup(
                                    services,
                                    transaction_id,
                                    &absolute_path,
                                    staged_backup,
                                    AppError::conflict(
                                        "The file changed after its backup was staged; read it again before editing",
                                    ),
                                )
                                .await,
                            );
                        }
                        let intended = prepare_mutation(
                            services,
                            transaction_id,
                            &absolute_path,
                            updated.as_bytes(),
                        )
                        .await?;
                        if context.cancellation.is_cancelled() {
                            return Err(
                                abort_prepared_mutation(
                                    services,
                                    transaction_id,
                                    &absolute_path,
                                    intended,
                                    staged_backup,
                                    AppError::cancelled(
                                        "The file edit was cancelled before commit",
                                    ),
                                )
                                .await,
                            );
                        }
                        let commit_path = match services
                            .file_system
                            .resolve(std::path::Path::new(raw_path))
                            .await
                        {
                            Ok(path) => path,
                            Err(error) => {
                                return Err(abort_prepared_mutation(
                                    services,
                                    transaction_id,
                                    &absolute_path,
                                    intended,
                                    staged_backup,
                                    error,
                                )
                                .await);
                            }
                        };
                        if let Err(error) = ensure_authorized_path(&resolved.path, &commit_path) {
                            return Err(abort_prepared_mutation(
                                services,
                                transaction_id,
                                &absolute_path,
                                intended,
                                staged_backup,
                                error,
                            )
                            .await);
                        }
                        if commit_path.identity_key() != safe_path.identity_key() {
                            return Err(abort_prepared_mutation(
                                services,
                                transaction_id,
                                &absolute_path,
                                intended,
                                staged_backup,
                                AppError::conflict(
                                    "The file path identity changed before the prepared edit could commit",
                                ),
                            )
                            .await);
                        }
                        let commit_base = match read_state(services, &commit_path).await {
                            Ok(state) => state,
                            Err(error) => {
                                return Err(abort_prepared_mutation(
                                    services,
                                    transaction_id,
                                    &absolute_path,
                                    intended,
                                    staged_backup,
                                    error,
                                )
                                .await);
                            }
                        };
                        if commit_base != before {
                            return Err(
                                abort_prepared_mutation(
                                    services,
                                    transaction_id,
                                    &absolute_path,
                                    intended,
                                    staged_backup,
                                    AppError::conflict(
                                        "The file changed before the prepared edit could commit",
                                    ),
                                )
                                .await,
                            );
                        }
                        if let Err(error) = services
                            .file_system
                            .write_atomic(&commit_path, updated.as_bytes())
                            .await
                        {
                            return Err(reconcile_failed_write(
                                services,
                                transaction_id,
                                &commit_path,
                                &before,
                                error,
                                staged_backup,
                                intended,
                            )
                            .await);
                        }
                        record_successful_mutation(
                            services,
                            context,
                            session_id,
                            transaction_id,
                            &absolute_path,
                            &intended,
                        )
                        .await
                    },
                    Some(&context.cancellation),
                )
                .await;
            match operation {
                Ok(sha256) => ToolExecutionResult::Success {
                    data: None,
                    model_content: format!("Successfully edited {raw_path}. SHA256: {sha256}"),
                    ui_content: None,
                    effects: None,
                },
                Err(error) => app_error(error),
            }
        })
    }
}

fn apply_edits(content: &str, edits: &[Value]) -> Result<String, AppError> {
    let mut updated = content.replace("\r\n", "\n");
    let mut applied_new_strings = Vec::with_capacity(edits.len());
    for (index, edit) in edits.iter().enumerate() {
        let old_string = edit
            .get("old_string")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::validation("Every edit requires old_string"))?;
        let new_string = edit
            .get("new_string")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::validation("Every edit requires new_string"))?;
        if old_string.is_empty() {
            return Err(AppError::validation(format!(
                "Edit {} has an empty old_string",
                index + 1
            )));
        }
        if old_string == new_string {
            return Err(AppError::validation(format!(
                "Edit {} does not change its matched text",
                index + 1
            )));
        }
        let old_string = old_string.replace("\r\n", "\n");
        let new_string = new_string.replace("\r\n", "\n");
        let old_without_trailing_newlines = old_string.trim_end_matches('\n');
        if !old_without_trailing_newlines.is_empty()
            && applied_new_strings
                .iter()
                .any(|previous: &String| previous.contains(old_without_trailing_newlines))
        {
            return Err(AppError::conflict(format!(
                "Edit {} targets text introduced by a previous edit",
                index + 1
            )));
        }
        let replace_all = edit
            .get("replace_all")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let count = updated.matches(&old_string).count();
        if count == 0 {
            return Err(AppError::conflict(format!(
                "Edit {} did not match the current file",
                index + 1
            )));
        }
        if count > 1 && !replace_all {
            return Err(AppError::conflict(format!(
                "Edit {} matched {count} locations; replace_all is required",
                index + 1
            )));
        }
        updated = if replace_all {
            updated.replace(&old_string, &new_string)
        } else {
            updated.replacen(&old_string, &new_string, 1)
        };
        applied_new_strings.push(new_string);
    }
    Ok(updated)
}

fn unparsed_plan(target: &str) -> ToolEffectPlan {
    ToolEffectPlan {
        effects: vec![ToolEffect::Unknown {
            target: target.to_string(),
        }],
        analysis_status: "unparsed".to_string(),
    }
}

fn path_error(error: ToolPathError) -> ToolExecutionResult {
    execution_error("TOOL_PATH_NOT_AUTHORIZED", &error.to_string(), false)
}

fn app_error(error: AppError) -> ToolExecutionResult {
    let (code, recoverable) = match error.kind() {
        AppErrorKind::Cancelled => ("TOOL_CANCELLED", true),
        AppErrorKind::Conflict => ("TOOL_EDIT_CONFLICT", true),
        AppErrorKind::NotFound => ("TOOL_FILE_NOT_FOUND", true),
        AppErrorKind::Validation => ("TOOL_EDIT_INVALID", true),
        AppErrorKind::PermissionDenied => ("TOOL_PATH_NOT_AUTHORIZED", false),
        _ => ("TOOL_WRITE_FAILED", false),
    };
    execution_error(code, error.public_message(), recoverable)
}

fn execution_error(code: &str, message: &str, recoverable: bool) -> ToolExecutionResult {
    ToolExecutionResult::Error {
        error: ToolExecutionError {
            code: code.to_string(),
            message: message.to_string(),
            recoverable,
            suggestion: None,
            retry_after_ms: None,
            details: None,
        },
        model_content: None,
        ui_content: None,
        effects: None,
    }
}

#[cfg(test)]
mod tests {
    use super::apply_edits;

    #[test]
    fn apply_edits_normalizes_crlf_before_matching() {
        let edits = vec![serde_json::json!({
            "old_string": "first\nsecond",
            "new_string": "changed"
        })];

        let result = apply_edits("first\r\nsecond\r\n", &edits)
            .expect("LF edit must match CRLF file content");

        assert_eq!(result, "changed\n");
    }

    #[test]
    fn apply_edits_rejects_targeting_text_introduced_by_an_earlier_edit() {
        let edits = vec![
            serde_json::json!({"old_string": "alpha", "new_string": "beta gamma"}),
            serde_json::json!({"old_string": "beta", "new_string": "delta"}),
        ];

        let error = apply_edits("alpha", &edits)
            .expect_err("a later edit must not consume text introduced by an earlier edit");

        assert!(error.to_string().contains("previous edit"));
    }
}
