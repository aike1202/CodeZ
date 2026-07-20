use std::sync::Arc;

use serde_json::Value;

use crate::search::{
    DEFAULT_GLOB_LIMIT, MAX_GLOB_LIMIT, MAX_SEARCH_PATH_BYTES, MAX_SEARCH_PATTERN_BYTES,
    SearchService,
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

/// Bounded workspace file-pattern search backed by the verified filesystem port.
pub struct GlobTool {
    descriptor: DefaultToolDescriptor,
    search: Arc<SearchService>,
}

impl GlobTool {
    #[must_use]
    pub fn new(search: Arc<SearchService>) -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name: "Glob",
                version: "1.1.0",
                source: ToolSource::Builtin,
                source_id: "builtin:glob".to_string(),
                summary: "Find files matching a glob pattern.".to_string(),
                description: "Finds files by name or path pattern inside the current workspace. Use this to discover an exact path before Read; use Grep instead for file contents. Scope broad patterns with path and narrow them when results truncate.".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "pattern": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": MAX_SEARCH_PATTERN_BYTES,
                            "description": "Glob pattern, e.g. **/*.ts."
                        },
                        "path": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": MAX_SEARCH_PATH_BYTES,
                            "description": "Optional workspace subdirectory."
                        },
                        "head_limit": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": MAX_GLOB_LIMIT,
                            "default": DEFAULT_GLOB_LIMIT,
                            "description": "Maximum matching paths to return."
                        }
                    },
                    "required": ["pattern"]
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
                    max_result_chars: 20_000,
                    timeout_ms: Some(35_000),
                },
            },
            search,
        }
    }
}

impl ToolHandler for GlobTool {
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
            let path = input.get("path").and_then(Value::as_str);
            let head_limit = input
                .get("head_limit")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok());
            let services = match authorized_services(context) {
                Ok(services) => services,
                Err(error) => return access_error(error),
            };
            let result = match self
                .search
                .glob_files_cancellable(
                    services.file_system.as_ref(),
                    pattern,
                    path,
                    head_limit,
                    context.cancellation.clone(),
                )
                .await
            {
                Ok(result) => result,
                Err(error) => return search_error(error),
            };
            let model_content = if result.paths.is_empty() {
                "No files matched.".to_string()
            } else if result.truncated {
                format!(
                    "{}\n\n[Glob results truncated: showing {} of at least {} discovered files. Use a narrower pattern or path.]",
                    result.paths.join("\n"),
                    result.paths.len(),
                    result.total
                )
            } else {
                result.paths.join("\n")
            };
            ToolExecutionResult::Success {
                data: Some(serde_json::json!({
                    "paths": result.paths,
                    "truncated": result.truncated,
                    "total": result.total
                })),
                model_content,
                ui_content: None,
                effects: None,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use codez_core::{AppError, CancellationToken, ProcessOutput, ProcessRequest, ProcessRunner};

    use super::*;

    struct UnusedRunner;

    impl ProcessRunner for UnusedRunner {
        fn run<'a>(
            &'a self,
            _request: ProcessRequest,
            _cancellation: CancellationToken,
        ) -> codez_core::PortFuture<'a, ProcessOutput> {
            Box::pin(async { Err(AppError::internal("unused runner")) })
        }
    }

    fn handler() -> GlobTool {
        let executable = std::env::temp_dir().join("rg-fixture");
        let search = SearchService::new(executable, Arc::new(UnusedRunner))
            .expect("absolute fixture executable path must be accepted");
        GlobTool::new(Arc::new(search))
    }

    #[test]
    fn schema_matches_the_electron_glob_contract_with_stricter_bounds() {
        let schema = handler().descriptor().input_schema();
        assert!(
            schema["required"] == serde_json::json!(["pattern"])
                && schema["properties"]["pattern"]["maxLength"]
                    == serde_json::json!(MAX_SEARCH_PATTERN_BYTES)
                && schema["properties"]["head_limit"]["maximum"]
                    == serde_json::json!(MAX_GLOB_LIMIT)
                && schema["properties"]["head_limit"]["default"]
                    == serde_json::json!(DEFAULT_GLOB_LIMIT)
                && schema["additionalProperties"] == serde_json::json!(false)
        );
    }

    #[tokio::test]
    async fn effects_are_read_only_workspace_search() {
        let workspace = std::env::temp_dir().join("glob-effect-workspace");
        let plan = handler()
            .plan_effects(
                &serde_json::json!({"pattern": "**/*.rs"}),
                &ToolPlanningContext {
                    workspace_root: workspace.clone(),
                    session_id: Some("session-1".to_string()),
                    agent_role: "main".to_string(),
                },
            )
            .await;
        assert!(matches!(
            plan.effects.as_slice(),
            [crate::tools::types::ToolEffect::ReadFile { path, scope }]
                if Path::new(path) == workspace && scope == "workspace"
        ));
    }
}
