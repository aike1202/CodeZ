use serde_json::Value;

use crate::search::{MAX_SEARCH_PATH_BYTES, SearchError, resolve_search_directory};
use crate::tools::builtin::search_support::{
    access_error, authorized_services, input_error, read_effect_plan, read_resource_keys,
    search_error,
};
use crate::tools::registry::{
    BoxFuture, DefaultToolDescriptor, ToolAvailability, ToolBehavior, ToolContext, ToolDescriptor,
    ToolHandler,
};
use crate::tools::types::{
    ModelPreference, ToolApprovalMetadata, ToolConcurrency, ToolEffectPlan, ToolExecutionResult,
    ToolExposure, ToolInterruptBehavior, ToolPlanningContext, ToolSource,
};

const MAX_DIRECTORY_PATHS: usize = 32;
const MAX_ENTRIES_PER_DIRECTORY: usize = 2_000;
const MAX_LIST_MODEL_CHARS: usize = 80_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ListInputError {
    InvalidPathCount,
    InvalidPath,
}

impl ListInputError {
    const fn message(self) -> &'static str {
        match self {
            Self::InvalidPathCount => "dirPaths must contain between 1 and 32 paths",
            Self::InvalidPath => "Every directory path must be a non-empty string",
        }
    }
}

/// Lists direct children of bounded workspace directories without following links.
pub struct ListFilesTool {
    descriptor: DefaultToolDescriptor,
}

impl ListFilesTool {
    #[must_use]
    pub fn new() -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name: "list_files",
                version: "1.0.0",
                source: ToolSource::Builtin,
                source_id: "builtin:list-files".to_string(),
                summary: "List files in a directory.".to_string(),
                description: "Lists direct files and directories within one or multiple workspace-relative directory paths. It does not follow links or recurse.".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "dirPaths": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": MAX_DIRECTORY_PATHS,
                            "uniqueItems": true,
                            "items": { "type": "string", "minLength": 1, "maxLength": MAX_SEARCH_PATH_BYTES },
                            "description": "Workspace-relative directories to list."
                        },
                        "dirPath": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": MAX_SEARCH_PATH_BYTES,
                            "description": "One workspace-relative directory (legacy parameter)."
                        }
                    }
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
                    concurrency: ToolConcurrency::Safe,
                    interrupt: ToolInterruptBehavior::Cancel,
                    max_result_chars: 100_000,
                    timeout_ms: Some(30_000),
                },
            },
        }
    }
}

impl Default for ListFilesTool {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolHandler for ListFilesTool {
    fn descriptor(&self) -> &dyn ToolDescriptor {
        &self.descriptor
    }

    fn plan_effects<'a>(
        &'a self,
        _input: &'a Value,
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, ToolEffectPlan> {
        Box::pin(async move { read_effect_plan(context) })
    }

    fn resource_keys<'a>(
        &'a self,
        _input: &'a Value,
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move { read_resource_keys(context) })
    }

    fn execute<'a>(
        &'a self,
        input: &'a Value,
        context: &'a ToolContext,
    ) -> BoxFuture<'a, ToolExecutionResult> {
        Box::pin(async move {
            let paths = match list_paths(input) {
                Ok(paths) => paths,
                Err(error) => return input_error(error.message()),
            };
            let services = match authorized_services(context) {
                Ok(services) => services,
                Err(error) => return access_error(error),
            };
            let multiple = paths.len() > 1;
            let mut sections = Vec::with_capacity(paths.len());
            let mut directories = Vec::with_capacity(paths.len());
            let mut output_truncated = false;
            let mut model_chars = 0_usize;

            for path in paths {
                if context.cancellation.is_cancelled() {
                    return search_error(SearchError::Cancelled);
                }
                let directory = match resolve_search_directory(
                    services.file_system.as_ref(),
                    Some(path.as_str()),
                )
                .await
                {
                    Ok(directory) => directory,
                    Err(error) => return search_error(error),
                };
                let mut listing = match services
                    .file_system
                    .read_directory(&directory, MAX_ENTRIES_PER_DIRECTORY)
                    .await
                {
                    Ok(listing) => listing,
                    Err(source) => {
                        return search_error(SearchError::Workspace {
                            source: Box::new(source),
                        });
                    }
                };
                listing.entries.sort_by(|left, right| {
                    let left_name = left.name.to_string_lossy();
                    let right_name = right.name.to_string_lossy();
                    left_name
                        .to_lowercase()
                        .cmp(&right_name.to_lowercase())
                        .then_with(|| left_name.cmp(&right_name))
                });
                let entries = listing
                    .entries
                    .into_iter()
                    .filter_map(|entry| {
                        let kind = match entry.kind {
                            codez_core::FileKind::Directory => "DIR",
                            codez_core::FileKind::File => "FILE",
                            codez_core::FileKind::SymbolicLink | codez_core::FileKind::Other => {
                                return None;
                            }
                        };
                        Some((kind, entry.name.to_string_lossy().into_owned()))
                    })
                    .collect::<Vec<_>>();
                let mut content = if entries.is_empty() {
                    "Empty directory.".to_string()
                } else {
                    entries
                        .iter()
                        .map(|(kind, name)| format!("[{kind}] {name}"))
                        .collect::<Vec<_>>()
                        .join("\n")
                };
                if listing.truncated {
                    content.push_str(&format!(
                        "\n[List truncated after {MAX_ENTRIES_PER_DIRECTORY} entries.]"
                    ));
                }
                let section = if multiple {
                    format!("=== Directory: {path} ===\n{content}")
                } else {
                    content
                };
                let separator_chars = usize::from(!sections.is_empty()) * 2;
                if model_chars
                    .saturating_add(separator_chars)
                    .saturating_add(section.len())
                    > MAX_LIST_MODEL_CHARS
                {
                    output_truncated = true;
                    break;
                }
                model_chars = model_chars
                    .saturating_add(separator_chars)
                    .saturating_add(section.len());
                sections.push(section);
                directories.push(serde_json::json!({
                    "path": path,
                    "entries": entries.iter().map(|(kind, name)| serde_json::json!({ "kind": kind, "name": name })).collect::<Vec<_>>(),
                    "truncated": listing.truncated
                }));
            }

            let mut model_content = sections.join("\n\n");
            if output_truncated {
                if !model_content.is_empty() {
                    model_content.push_str("\n\n");
                }
                model_content.push_str(
                    "[List output truncated at the model result limit. Request fewer directories.]",
                );
            }
            ToolExecutionResult::Success {
                data: Some(serde_json::json!({
                    "directories": directories,
                    "truncated": output_truncated
                })),
                model_content,
                ui_content: None,
                effects: None,
            }
        })
    }
}

fn list_paths(input: &Value) -> Result<Vec<String>, ListInputError> {
    if let Some(values) = input.get("dirPaths").and_then(Value::as_array) {
        if values.is_empty() || values.len() > MAX_DIRECTORY_PATHS {
            return Err(ListInputError::InvalidPathCount);
        }
        return values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .filter(|path| !path.is_empty())
                    .map(str::to_string)
                    .ok_or(ListInputError::InvalidPath)
            })
            .collect();
    }
    if let Some(path) = input.get("dirPath").and_then(Value::as_str) {
        if path.is_empty() {
            return Err(ListInputError::InvalidPath);
        }
        return Ok(vec![path.to_string()]);
    }
    Ok(vec![".".to_string()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_preserves_plural_and_legacy_electron_inputs() {
        let schema = ListFilesTool::new().descriptor().input_schema();
        assert!(
            schema["properties"].get("dirPaths").is_some()
                && schema["properties"].get("dirPath").is_some()
                && schema["properties"]["dirPaths"]["maxItems"]
                    == serde_json::json!(MAX_DIRECTORY_PATHS)
                && schema["additionalProperties"] == serde_json::json!(false)
        );
    }

    #[test]
    fn absent_path_defaults_to_workspace_root() {
        assert_eq!(
            list_paths(&serde_json::json!({})).expect("empty input must use the root"),
            ["."]
        );
    }

    #[test]
    fn excessive_path_batches_are_rejected() {
        let paths = (0..=MAX_DIRECTORY_PATHS)
            .map(|index| format!("dir-{index}"))
            .collect::<Vec<_>>();
        assert!(list_paths(&serde_json::json!({"dirPaths": paths})).is_err());
    }
}
