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

pub struct WriteTool {
    descriptor: DefaultToolDescriptor,
}

impl WriteTool {
    #[must_use]
    pub fn new() -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name: "Write",
                version: "1.1.0",
                source: ToolSource::Builtin,
                source_id: "builtin:write".to_string(),
                summary: "Write or overwrite a file.".to_string(),
                description: "Writes a UTF-8 file after exact path authorization.".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "file_path": { "type": "string", "minLength": 1 },
                        "content": { "type": "string" }
                    },
                    "required": ["file_path", "content"]
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

impl Default for WriteTool {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolHandler for WriteTool {
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
                return unparsed_plan("write-path-missing");
            };
            match resolve_tool_path(raw_path, &context.workspace_root).await {
                Ok(resolved) => ToolEffectPlan {
                    effects: vec![ToolEffect::WriteFile {
                        path: resolved.path.to_string_lossy().to_string(),
                        mode: if tokio::fs::try_exists(&resolved.path).await.unwrap_or(true) {
                            "overwrite"
                        } else {
                            "create"
                        }
                        .to_string(),
                    }],
                    analysis_status: if resolved.inside_workspace {
                        "parsed"
                    } else {
                        "external"
                    }
                    .to_string(),
                },
                Err(_) => unparsed_plan("write-path-analysis"),
            }
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
            let Some(content) = arguments.get("content").and_then(Value::as_str) else {
                return execution_error("TOOL_INPUT_INVALID", "content is required", true);
            };
            let resolved = match resolve_tool_path(raw_path, &context.workspace_root).await {
                Ok(resolved) => resolved,
                Err(error) => return path_error(error),
            };
            if !resolved.inside_workspace {
                return path_error(ToolPathError::OutsideWorkspace);
            }
            let approved = context.authorized_effects.effects.iter().any(|effect| {
                matches!(effect, ToolEffect::WriteFile { path, .. } if std::path::Path::new(path) == resolved.path)
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
            let new_bytes = content.as_bytes();
            let operation = services
                .mutation_coordinator
                .run(
                    &absolute_path,
                    || async {
                        ensure_authorized_path(&resolved.path, &safe_path)?;
                        let before = read_state(services, &safe_path).await?;
                        if before.bytes.as_deref() == Some(new_bytes) {
                            return Ok(None);
                        }
                        if before.bytes.is_some() {
                            require_current_delivery(
                                services,
                                context,
                                session_id,
                                &absolute_path,
                                &before,
                            )?;
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
                                        "The file changed after its backup was staged; read it again before writing",
                                    ),
                                )
                                .await,
                            );
                        }
                        let intended = prepare_mutation(
                            services,
                            transaction_id,
                            &absolute_path,
                            new_bytes,
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
                                        "The file write was cancelled before commit",
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
                                    "The file path identity changed before the prepared write could commit",
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
                                        "The file changed before the prepared write could commit",
                                    ),
                                )
                                .await,
                            );
                        }
                        if let Err(error) = services
                            .file_system
                            .write_atomic(&commit_path, new_bytes)
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
                        let sha256 = record_successful_mutation(
                            services,
                            context,
                            session_id,
                            transaction_id,
                            &absolute_path,
                            &intended,
                        )
                        .await?;
                        Ok(Some(sha256))
                    },
                    Some(&context.cancellation),
                )
                .await;
            match operation {
                Ok(Some(sha256)) => ToolExecutionResult::Success {
                    data: None,
                    model_content: format!("Successfully wrote {raw_path}. SHA256: {sha256}"),
                    ui_content: None,
                    effects: None,
                },
                Ok(None) => ToolExecutionResult::Success {
                    data: None,
                    model_content: format!(
                        "No write was needed for {raw_path}; content is unchanged."
                    ),
                    ui_content: None,
                    effects: None,
                },
                Err(error) => app_error(error),
            }
        })
    }
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
        AppErrorKind::Conflict => ("TOOL_FILE_STALE", true),
        AppErrorKind::NotFound | AppErrorKind::Validation => ("TOOL_WRITE_INVALID", true),
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
