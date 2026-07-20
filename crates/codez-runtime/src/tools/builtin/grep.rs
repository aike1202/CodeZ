use std::sync::Arc;

use serde_json::Value;

use crate::search::{
    GrepOptions, GrepOutputMode, MAX_GREP_LIMIT, MAX_SEARCH_FILTER_BYTES, MAX_SEARCH_PATH_BYTES,
    MAX_SEARCH_PATTERN_BYTES, SearchService,
};
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

/// Bounded regex content search executed by bundled ripgrep without a shell.
pub struct GrepTool {
    descriptor: DefaultToolDescriptor,
    search: Arc<SearchService>,
}

impl GrepTool {
    #[must_use]
    pub fn new(search: Arc<SearchService>) -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name: "Grep",
                version: "1.1.0",
                source: ToolSource::Builtin,
                source_id: "builtin:grep".to_string(),
                summary: "Search file contents with regex patterns.".to_string(),
                description: "Searches file contents with regex using bundled ripgrep. Path may be one existing file or directory. Prefer files_with_matches for discovery, then narrow with content mode, a path or glob, and pagination.".to_string(),
                input_schema: grep_schema(),
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
                    max_result_chars: 20_000,
                    timeout_ms: Some(35_000),
                },
            },
            search,
        }
    }
}

impl ToolHandler for GrepTool {
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
            let Some(pattern) = input.get("pattern").and_then(Value::as_str) else {
                return input_error("pattern is required");
            };
            let options = grep_options(input);
            let services = match authorized_services(context) {
                Ok(services) => services,
                Err(error) => return access_error(error),
            };
            let result = match self
                .search
                .grep_filesystem(
                    services.file_system.as_ref(),
                    pattern,
                    input.get("path").and_then(Value::as_str),
                    &options,
                    context.cancellation.clone(),
                )
                .await
            {
                Ok(result) => result,
                Err(error) => return search_error(error),
            };
            let model_content = if result.lines.is_empty() {
                "No matches found.".to_string()
            } else if result.truncated {
                format!(
                    "{}\n\n[Grep results truncated after {} entries. Narrow the pattern/path or paginate with offset.]",
                    result.lines.join("\n"),
                    result.lines.len()
                )
            } else {
                result.lines.join("\n")
            };
            ToolExecutionResult::Success {
                data: Some(serde_json::json!({
                    "lines": result.lines,
                    "truncated": result.truncated
                })),
                model_content,
                ui_content: None,
                effects: None,
            }
        })
    }
}

fn grep_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "pattern": { "type": "string", "minLength": 1, "maxLength": MAX_SEARCH_PATTERN_BYTES, "description": "Regular expression to search for." },
            "path": { "type": "string", "minLength": 1, "maxLength": MAX_SEARCH_PATH_BYTES, "description": "Optional existing workspace file or directory. Defaults to the workspace root." },
            "output_mode": { "type": "string", "enum": ["files_with_matches", "content", "count"], "default": "files_with_matches", "description": "Use files_with_matches for the smallest discovery result, content for matching lines, or count for per-file totals." },
            "glob": { "type": "string", "minLength": 1, "maxLength": MAX_SEARCH_FILTER_BYTES, "description": "Glob filter, e.g. **/*.tsx." },
            "type": { "type": "string", "minLength": 1, "maxLength": MAX_SEARCH_FILTER_BYTES, "description": "Ripgrep file type, e.g. rust or js." },
            "-A": { "type": "integer", "minimum": 0, "maximum": 1000, "description": "Context lines after a match." },
            "-B": { "type": "integer", "minimum": 0, "maximum": 1000, "description": "Context lines before a match." },
            "-C": { "type": "integer", "minimum": 0, "maximum": 1000, "description": "Context lines around a match." },
            "-n": { "type": "boolean", "description": "Show line numbers in content mode." },
            "-i": { "type": "boolean", "description": "Case-insensitive search." },
            "-o": { "type": "boolean", "description": "Print only matched parts." },
            "multiline": { "type": "boolean", "description": "Enable multiline matching." },
            "head_limit": { "type": "integer", "minimum": 1, "maximum": MAX_GREP_LIMIT, "description": "Maximum returned lines or items. Defaults to 200 for content and 500 for files/count." },
            "offset": { "type": "integer", "minimum": 0, "maximum": 100000, "default": 0 }
        },
        "required": ["pattern"]
    })
}

fn grep_options(input: &Value) -> GrepOptions {
    let output_mode = match input.get("output_mode").and_then(Value::as_str) {
        Some("content") => GrepOutputMode::Content,
        Some("count") => GrepOutputMode::Count,
        _ => GrepOutputMode::FilesWithMatches,
    };
    GrepOptions {
        output_mode,
        glob_filter: input
            .get("glob")
            .and_then(Value::as_str)
            .map(str::to_string),
        type_filter: input
            .get("type")
            .and_then(Value::as_str)
            .map(str::to_string),
        case_insensitive: input.get("-i").and_then(Value::as_bool).unwrap_or(false),
        multiline: input
            .get("multiline")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        context_after: value_u32(input, "-A"),
        context_before: value_u32(input, "-B"),
        context_around: value_u32(input, "-C"),
        line_numbers: input.get("-n").and_then(Value::as_bool).unwrap_or(false),
        only_matching: input.get("-o").and_then(Value::as_bool).unwrap_or(false),
        head_limit: value_usize(input, "head_limit"),
        offset: value_usize(input, "offset"),
    }
}

fn value_u32(input: &Value, key: &str) -> Option<u32> {
    input
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

fn value_usize(input: &Value, key: &str) -> Option<usize> {
    input
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_preserves_the_electron_grep_property_names() {
        let schema = grep_schema();
        let properties = schema["properties"]
            .as_object()
            .expect("schema properties must be an object");
        assert!(
            [
                "pattern",
                "path",
                "output_mode",
                "glob",
                "type",
                "-A",
                "-B",
                "-C",
                "-n",
                "-i",
                "-o",
                "multiline",
                "head_limit",
                "offset",
            ]
            .iter()
            .all(|name| properties.contains_key(*name))
                && schema["required"] == serde_json::json!(["pattern"])
                && schema["additionalProperties"] == serde_json::json!(false)
        );
    }

    #[test]
    fn arguments_map_to_grep_options_without_string_parsing() {
        let options = grep_options(&serde_json::json!({
            "pattern": "错误",
            "output_mode": "content",
            "glob": "**/*.rs",
            "-C": 3,
            "-n": true,
            "head_limit": 42,
            "offset": 7
        }));
        assert_eq!(
            options,
            GrepOptions {
                output_mode: GrepOutputMode::Content,
                glob_filter: Some("**/*.rs".to_string()),
                context_around: Some(3),
                line_numbers: true,
                head_limit: Some(42),
                offset: Some(7),
                ..GrepOptions::default()
            }
        );
    }
}
