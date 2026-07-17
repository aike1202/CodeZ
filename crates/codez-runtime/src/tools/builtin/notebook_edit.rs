use std::{collections::HashSet, path::Path};

use codez_core::{AppError, AppErrorKind};
use serde_json::{Map, Value};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NotebookEditMode {
    Replace,
    Insert,
    Delete,
}

#[derive(Debug)]
struct NotebookEditInput<'a> {
    notebook_path: &'a str,
    cell_id: Option<&'a str>,
    cell_index: Option<usize>,
    cell_type: Option<&'a str>,
    new_source: Option<&'a str>,
    mode: NotebookEditMode,
}

/// Structured, transactional Jupyter notebook cell editor.
pub struct NotebookEditTool {
    descriptor: DefaultToolDescriptor,
}

impl NotebookEditTool {
    #[must_use]
    pub fn new() -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name: "NotebookEdit",
                version: "1.0.0",
                source: ToolSource::Builtin,
                source_id: "builtin:notebook-edit".to_string(),
                summary: "Edit cells in a Jupyter notebook.".to_string(),
                description: concat!(
                    "Replaces, inserts, or deletes one cell in a validated .ipynb file after ",
                    "the current notebook was read in this agent context."
                )
                .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "notebook_path": { "type": "string", "minLength": 1 },
                        "cell_id": { "type": "string", "minLength": 1 },
                        "cell_index": { "type": "integer", "minimum": 0 },
                        "cell_type": { "type": "string", "enum": ["code", "markdown", "raw"] },
                        "new_source": { "type": "string" },
                        "edit_mode": { "type": "string", "enum": ["replace", "insert", "delete"] }
                    },
                    "required": ["notebook_path"]
                }),
                approval: ToolApprovalMetadata {
                    model_preference: ModelPreference::NotApplicable,
                },
                availability: ToolAvailability {
                    roles: None,
                    platforms: None,
                    exposure: ToolExposure::Deferred,
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

impl Default for NotebookEditTool {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolHandler for NotebookEditTool {
    fn descriptor(&self) -> &dyn ToolDescriptor {
        &self.descriptor
    }

    fn plan_effects<'a>(
        &'a self,
        input: &'a Value,
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, ToolEffectPlan> {
        Box::pin(async move {
            let Some(raw_path) = input.get("notebook_path").and_then(Value::as_str) else {
                return unparsed_plan("notebook-path-missing");
            };
            resolve_tool_path(raw_path, &context.workspace_root)
                .await
                .map_or_else(
                    |_| unparsed_plan("notebook-path-analysis"),
                    |resolved| ToolEffectPlan {
                        effects: vec![ToolEffect::WriteFile {
                            path: resolved.path.to_string_lossy().to_string(),
                            mode: "modify".to_string(),
                        }],
                        analysis_status: if resolved.inside_workspace {
                            "parsed"
                        } else {
                            "external"
                        }
                        .to_string(),
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
            let Some(raw_path) = input.get("notebook_path").and_then(Value::as_str) else {
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
            let input = match parse_input(arguments) {
                Ok(input) => input,
                Err(error) => return app_error(error),
            };
            let resolved =
                match resolve_tool_path(input.notebook_path, &context.workspace_root).await {
                    Ok(resolved) => resolved,
                    Err(error) => return path_error(error),
                };
            if !resolved.inside_workspace {
                return path_error(ToolPathError::OutsideWorkspace);
            }
            if !has_notebook_extension(&resolved.path) {
                return execution_error(
                    "TOOL_NOTEBOOK_INVALID",
                    "notebook_path must identify a .ipynb file",
                    true,
                );
            }
            let approved = context.authorized_effects.effects.iter().any(|effect| {
                matches!(effect, ToolEffect::WriteFile { path, mode }
                    if mode == "modify" && Path::new(path) == resolved.path)
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
                .resolve(Path::new(input.notebook_path))
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
                        let original = before.text()?.ok_or_else(|| {
                            AppError::not_found("The notebook file does not exist")
                        })?;
                        require_current_delivery(
                            services,
                            context,
                            session_id,
                            &absolute_path,
                            &before,
                        )?;
                        let mut notebook = parse_notebook(original)?;
                        apply_edit(&mut notebook, &input)?;
                        let updated = serialize_notebook(&notebook)?;
                        if updated.as_bytes() == original.as_bytes() {
                            return Err(AppError::validation(
                                "The notebook edit produces no net change",
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
                            return Err(abort_staged_backup(
                                services,
                                transaction_id,
                                &absolute_path,
                                staged_backup,
                                AppError::conflict(
                                    "The notebook changed after its backup was staged; read it again",
                                ),
                            )
                            .await);
                        }
                        let intended = prepare_mutation(
                            services,
                            transaction_id,
                            &absolute_path,
                            updated.as_bytes(),
                        )
                        .await?;
                        if context.cancellation.is_cancelled() {
                            return Err(abort_prepared_mutation(
                                services,
                                transaction_id,
                                &absolute_path,
                                intended,
                                staged_backup,
                                AppError::cancelled(
                                    "The notebook edit was cancelled before commit",
                                ),
                            )
                            .await);
                        }

                        let commit_path = match services
                            .file_system
                            .resolve(Path::new(input.notebook_path))
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
                                    "The notebook path identity changed before commit",
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
                            return Err(abort_prepared_mutation(
                                services,
                                transaction_id,
                                &absolute_path,
                                intended,
                                staged_backup,
                                AppError::conflict(
                                    "The notebook changed before the prepared edit could commit",
                                ),
                            )
                            .await);
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
                    data: Some(serde_json::json!({
                        "notebookPath": absolute_path,
                        "sha256": sha256,
                        "editMode": mode_name(input.mode),
                    })),
                    model_content: format!(
                        "Successfully edited notebook {}. SHA256: {sha256}",
                        input.notebook_path
                    ),
                    ui_content: None,
                    effects: None,
                },
                Err(error) => app_error(error),
            }
        })
    }
}

fn parse_input(arguments: &Value) -> Result<NotebookEditInput<'_>, AppError> {
    let notebook_path = arguments
        .get("notebook_path")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::validation("notebook_path is required"))?;
    let cell_id = arguments.get("cell_id").and_then(Value::as_str);
    if cell_id.is_some_and(str::is_empty) {
        return Err(AppError::validation("cell_id must not be empty"));
    }
    let cell_index = arguments
        .get("cell_index")
        .and_then(Value::as_u64)
        .map(usize::try_from)
        .transpose()
        .map_err(|_| AppError::validation("cell_index is too large"))?;
    if cell_id.is_some() && cell_index.is_some() {
        return Err(AppError::validation(
            "Specify either cell_id or cell_index, not both",
        ));
    }
    let mode = match arguments
        .get("edit_mode")
        .and_then(Value::as_str)
        .unwrap_or("replace")
    {
        "replace" => NotebookEditMode::Replace,
        "insert" => NotebookEditMode::Insert,
        "delete" => NotebookEditMode::Delete,
        other => {
            return Err(AppError::validation(format!(
                "Unsupported notebook edit_mode: {other}"
            )));
        }
    };
    let cell_type = arguments.get("cell_type").and_then(Value::as_str);
    if cell_type.is_some_and(|value| !is_cell_type(value)) {
        return Err(AppError::validation(
            "cell_type must be code, markdown, or raw",
        ));
    }
    Ok(NotebookEditInput {
        notebook_path,
        cell_id,
        cell_index,
        cell_type,
        new_source: arguments.get("new_source").and_then(Value::as_str),
        mode,
    })
}

fn parse_notebook(text: &str) -> Result<Value, AppError> {
    let notebook: Value = serde_json::from_str(text)
        .map_err(|error| AppError::validation(format!("Invalid notebook JSON: {error}")))?;
    validate_notebook(&notebook)?;
    Ok(notebook)
}

fn validate_notebook(notebook: &Value) -> Result<(), AppError> {
    let object = notebook
        .as_object()
        .ok_or_else(|| AppError::validation("A notebook must be a JSON object"))?;
    if object.get("metadata").and_then(Value::as_object).is_none() {
        return Err(AppError::validation(
            "Invalid notebook: metadata must be an object",
        ));
    }
    let nbformat = notebook_format_field(object, "nbformat")?;
    let nbformat_minor = notebook_format_field(object, "nbformat_minor")?;
    let requires_cell_id = nbformat == 4 && nbformat_minor >= 5;
    let cells = object
        .get("cells")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::validation("Invalid notebook: cells must be an array"))?;
    let mut ids = HashSet::new();
    for (index, cell) in cells.iter().enumerate() {
        validate_cell(cell, index, requires_cell_id, &mut ids)?;
    }
    Ok(())
}

fn notebook_format_field(object: &Map<String, Value>, field: &str) -> Result<u64, AppError> {
    object.get(field).and_then(Value::as_u64).ok_or_else(|| {
        AppError::validation(format!(
            "Invalid notebook: {field} must be a non-negative integer"
        ))
    })
}

fn validate_cell(
    cell: &Value,
    index: usize,
    requires_cell_id: bool,
    ids: &mut HashSet<String>,
) -> Result<(), AppError> {
    let object = cell.as_object().ok_or_else(|| {
        AppError::validation(format!("Invalid notebook: cell {index} must be an object"))
    })?;
    let cell_type = object
        .get("cell_type")
        .and_then(Value::as_str)
        .filter(|value| is_cell_type(value))
        .ok_or_else(|| {
            AppError::validation(format!(
                "Invalid notebook: cell {index} has an unsupported cell_type"
            ))
        })?;
    if object.get("metadata").and_then(Value::as_object).is_none() {
        return Err(AppError::validation(format!(
            "Invalid notebook: cell {index} metadata must be an object"
        )));
    }
    if !object.get("source").is_some_and(valid_source) {
        return Err(AppError::validation(format!(
            "Invalid notebook: cell {index} source must be a string or string array"
        )));
    }
    if cell_type == "code"
        && object
            .get("outputs")
            .is_some_and(|outputs| !outputs.is_array())
    {
        return Err(AppError::validation(format!(
            "Invalid notebook: code cell {index} outputs must be an array"
        )));
    }
    if let Some(id) = object.get("id") {
        let id = id
            .as_str()
            .filter(|value| valid_cell_id(value))
            .ok_or_else(|| {
                AppError::validation(format!("Invalid notebook: cell {index} has a malformed id"))
            })?;
        if !ids.insert(id.to_string()) {
            return Err(AppError::validation(format!(
                "Invalid notebook: duplicate cell id {id}"
            )));
        }
    } else if requires_cell_id {
        return Err(AppError::validation(format!(
            "Invalid notebook: cell {index} requires an id for nbformat 4.5 or newer"
        )));
    }
    Ok(())
}

fn valid_source(source: &Value) -> bool {
    source.is_string()
        || source
            .as_array()
            .is_some_and(|lines| lines.iter().all(Value::is_string))
}

fn valid_cell_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn apply_edit(notebook: &mut Value, input: &NotebookEditInput<'_>) -> Result<(), AppError> {
    let cells = notebook
        .get_mut("cells")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| AppError::internal("validated notebook cells became unavailable"))?;
    let target = find_target(cells, input.cell_id, input.cell_index)?;
    match input.mode {
        NotebookEditMode::Replace => {
            let index = target.ok_or_else(|| {
                AppError::validation("cell_id or cell_index is required for replace")
            })?;
            let source = input
                .new_source
                .ok_or_else(|| AppError::validation("new_source is required for replace"))?;
            let cell = cells
                .get_mut(index)
                .and_then(Value::as_object_mut)
                .ok_or_else(|| AppError::internal("validated target cell became unavailable"))?;
            cell.insert("source".to_string(), Value::Array(string_to_source(source)));
        }
        NotebookEditMode::Insert => {
            let source = input
                .new_source
                .ok_or_else(|| AppError::validation("new_source is required for insert"))?;
            let cell_type = input.cell_type.unwrap_or("code");
            let new_cell = new_cell(cell_type, source);
            let insertion_index = target.map_or(0, |index| index.saturating_add(1));
            cells.insert(insertion_index, new_cell);
        }
        NotebookEditMode::Delete => {
            let index = target.ok_or_else(|| {
                AppError::validation("cell_id or cell_index is required for delete")
            })?;
            cells.remove(index);
        }
    }
    Ok(())
}

fn find_target(
    cells: &[Value],
    cell_id: Option<&str>,
    cell_index: Option<usize>,
) -> Result<Option<usize>, AppError> {
    if let Some(index) = cell_index {
        return cells
            .get(index)
            .map(|_| Some(index))
            .ok_or_else(|| cell_not_found(format!("Notebook cell_index {index} was not found")));
    }
    let Some(id) = cell_id else {
        return Ok(None);
    };
    cells
        .iter()
        .enumerate()
        .find_map(|(index, cell)| {
            (cell.get("id").and_then(Value::as_str) == Some(id)).then_some(index)
        })
        .map(Some)
        .ok_or_else(|| cell_not_found(format!("Notebook cell_id {id} was not found")))
}

fn new_cell(cell_type: &str, source: &str) -> Value {
    let mut cell = Map::new();
    cell.insert(
        "cell_type".to_string(),
        Value::String(cell_type.to_string()),
    );
    cell.insert(
        "id".to_string(),
        Value::String(uuid::Uuid::new_v4().simple().to_string()),
    );
    cell.insert("metadata".to_string(), Value::Object(Map::new()));
    cell.insert("source".to_string(), Value::Array(string_to_source(source)));
    if cell_type == "code" {
        cell.insert("execution_count".to_string(), Value::Null);
        cell.insert("outputs".to_string(), Value::Array(Vec::new()));
    }
    Value::Object(cell)
}

fn string_to_source(source: &str) -> Vec<Value> {
    if source.is_empty() {
        return Vec::new();
    }
    let lines = source.split('\n').collect::<Vec<_>>();
    let last = lines.len().saturating_sub(1);
    lines
        .into_iter()
        .enumerate()
        .map(|(index, line)| {
            Value::String(if index < last {
                format!("{line}\n")
            } else {
                line.to_string()
            })
        })
        .collect()
}

fn serialize_notebook(notebook: &Value) -> Result<String, AppError> {
    serde_json::to_string_pretty(notebook)
        .map_err(|error| AppError::internal(format!("Failed to serialize notebook: {error}")))
}

fn has_notebook_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("ipynb"))
}

fn is_cell_type(cell_type: &str) -> bool {
    matches!(cell_type, "code" | "markdown" | "raw")
}

fn mode_name(mode: NotebookEditMode) -> &'static str {
    match mode {
        NotebookEditMode::Replace => "replace",
        NotebookEditMode::Insert => "insert",
        NotebookEditMode::Delete => "delete",
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
        AppErrorKind::Conflict => ("TOOL_NOTEBOOK_STALE", true),
        AppErrorKind::NotFound if is_cell_not_found(&error) => {
            ("TOOL_NOTEBOOK_CELL_NOT_FOUND", true)
        }
        AppErrorKind::NotFound => ("TOOL_NOTEBOOK_NOT_FOUND", true),
        AppErrorKind::Validation => ("TOOL_NOTEBOOK_INVALID", true),
        AppErrorKind::PermissionDenied => ("TOOL_PATH_NOT_AUTHORIZED", false),
        _ => ("TOOL_NOTEBOOK_WRITE_FAILED", false),
    };
    if error.kind() == AppErrorKind::Cancelled {
        ToolExecutionResult::Cancelled {
            error: tool_error(code, error.public_message(), recoverable),
            model_content: None,
            ui_content: None,
            effects: None,
        }
    } else {
        execution_error(code, error.public_message(), recoverable)
    }
}

const CELL_NOT_FOUND_PREFIX: &str = "Notebook cell_";

fn cell_not_found(message: String) -> AppError {
    AppError::not_found(message)
}

fn is_cell_not_found(error: &AppError) -> bool {
    error.public_message().starts_with(CELL_NOT_FOUND_PREFIX)
}

fn execution_error(code: &str, message: &str, recoverable: bool) -> ToolExecutionResult {
    ToolExecutionResult::Error {
        error: tool_error(code, message, recoverable),
        model_content: None,
        ui_content: None,
        effects: None,
    }
}

fn tool_error(code: &str, message: &str, recoverable: bool) -> ToolExecutionError {
    ToolExecutionError {
        code: code.to_string(),
        message: message.to_string(),
        recoverable,
        suggestion: None,
        retry_after_ms: None,
        details: None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use codez_core::AppError;

    use crate::tools::types::ToolExecutionResult;

    use super::{
        NotebookEditMode, app_error, apply_edit, parse_input, parse_notebook, serialize_notebook,
    };

    fn notebook() -> Value {
        parse_notebook(
            r#"{
                "cells": [
                    {"cell_type":"code","id":"alpha","metadata":{},"source":["print('旧')\n"],"outputs":[]},
                    {"cell_type":"markdown","id":"beta","metadata":{},"source":["标题\n"]}
                ],
                "metadata": {},
                "nbformat": 4,
                "nbformat_minor": 5
            }"#,
        )
        .expect("fixture notebook must be valid")
    }

    #[test]
    fn replace_insert_and_delete_support_unicode_id_and_index_targets() {
        let mut value = notebook();
        let replace_args = serde_json::json!({
            "notebook_path": "fixture.ipynb",
            "cell_id": "alpha",
            "new_source": "print('新')\n",
            "edit_mode": "replace"
        });
        let replace = parse_input(&replace_args).expect("replace input must be valid");
        apply_edit(&mut value, &replace).expect("replace must succeed");
        let insert_args = serde_json::json!({
            "notebook_path": "fixture.ipynb",
            "cell_index": 0,
            "cell_type": "raw",
            "new_source": "数据",
            "edit_mode": "insert"
        });
        let insert = parse_input(&insert_args).expect("insert input must be valid");
        apply_edit(&mut value, &insert).expect("insert must succeed");
        let delete_args = serde_json::json!({
            "notebook_path": "fixture.ipynb",
            "cell_index": 2,
            "edit_mode": "delete"
        });
        let delete = parse_input(&delete_args).expect("delete input must be valid");
        apply_edit(&mut value, &delete).expect("delete must succeed");
        let serialized = serialize_notebook(&value).expect("notebook must serialize");

        assert!(
            replace.mode == NotebookEditMode::Replace
                && serialized.contains("print('新')")
                && serialized.contains("数据")
                && !serialized.contains("标题")
        );
    }

    #[test]
    fn malformed_notebook_shapes_and_duplicate_ids_are_rejected() {
        let invalid_json = parse_notebook("{not-json");
        let invalid_source = parse_notebook(
            r#"{"cells":[{"cell_type":"code","metadata":{},"source":[1],"id":"same"},{"cell_type":"raw","metadata":{},"source":[],"id":"same"}],"metadata":{},"nbformat":4,"nbformat_minor":5}"#,
        );

        assert!(invalid_json.is_err() && invalid_source.is_err());
    }

    #[test]
    fn inserting_a_cell_assigns_a_persisted_valid_identity() {
        let mut value = notebook();
        let arguments = serde_json::json!({
            "notebook_path": "fixture.ipynb",
            "new_source": "x = 1",
            "edit_mode": "insert"
        });
        let input = parse_input(&arguments).expect("insert input must be valid");

        apply_edit(&mut value, &input).expect("insert must succeed");
        let id = value["cells"][0]["id"]
            .as_str()
            .expect("inserted cell must have an id");

        assert!(id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn nbformat_four_point_five_requires_every_cell_to_have_an_id() {
        let parsed = parse_notebook(
            r#"{"cells":[{"cell_type":"raw","metadata":{},"source":[]}],"metadata":{},"nbformat":4,"nbformat_minor":5}"#,
        );

        let error = parsed.expect_err("nbformat 4.5 cells without IDs must be rejected");

        assert!(error.public_message().contains("requires an id"));
    }

    #[test]
    fn legacy_idless_cells_require_an_index_and_do_not_shadow_explicit_ids() {
        let mut value = parse_notebook(
            r#"{"cells":[{"cell_type":"raw","metadata":{},"source":["idless"]},{"cell_type":"raw","id":"cell-0","metadata":{},"source":["explicit"]}],"metadata":{},"nbformat":4,"nbformat_minor":4}"#,
        )
        .expect("legacy notebook fixture must be valid");
        let explicit_arguments = serde_json::json!({
            "notebook_path": "fixture.ipynb",
            "cell_id": "cell-0",
            "new_source": "explicit updated",
            "edit_mode": "replace"
        });
        let explicit = parse_input(&explicit_arguments).expect("explicit ID input must be valid");
        apply_edit(&mut value, &explicit).expect("explicit ID must select the persisted ID");
        let index_arguments = serde_json::json!({
            "notebook_path": "fixture.ipynb",
            "cell_index": 0,
            "new_source": "idless updated",
            "edit_mode": "replace"
        });
        let by_index = parse_input(&index_arguments).expect("index input must be valid");
        apply_edit(&mut value, &by_index).expect("index must select the idless cell");

        assert!(
            value["cells"][0]["source"][0] == "idless updated"
                && value["cells"][1]["source"][0] == "explicit updated"
        );
    }

    #[test]
    fn notebook_not_found_and_cell_not_found_use_distinct_tool_codes() {
        let cell = app_error(AppError::not_found(
            "Notebook cell_id missing was not found",
        ));
        let resource = app_error(AppError::not_found("The notebook file does not exist"));
        let ToolExecutionResult::Error {
            error: cell_error, ..
        } = cell
        else {
            panic!("cell lookup failure must be a tool error");
        };
        let ToolExecutionResult::Error {
            error: resource_error,
            ..
        } = resource
        else {
            panic!("notebook lookup failure must be a tool error");
        };

        assert_eq!(
            (cell_error.code.as_str(), resource_error.code.as_str()),
            ("TOOL_NOTEBOOK_CELL_NOT_FOUND", "TOOL_NOTEBOOK_NOT_FOUND")
        );
    }
}
