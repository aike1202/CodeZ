use std::path::Path;

use crate::search::SearchError;
use crate::tools::builtin::file_mutation::services;
use crate::tools::registry::{ToolContext, ToolFileServices};
use crate::tools::types::{
    ToolEffect, ToolEffectPlan, ToolExecutionError, ToolExecutionResult, ToolPlanningContext,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SearchToolAccessError {
    AuthorizationMismatch,
    ServicesUnavailable,
}

pub(super) fn read_effect_plan(context: &ToolPlanningContext) -> ToolEffectPlan {
    ToolEffectPlan {
        effects: vec![ToolEffect::ReadFile {
            path: context.workspace_root.to_string_lossy().into_owned(),
            scope: "workspace".to_string(),
        }],
        analysis_status: "parsed".to_string(),
    }
}

pub(super) fn read_resource_keys(context: &ToolPlanningContext) -> Vec<String> {
    vec![format!("{}:read", context.workspace_root.to_string_lossy())]
}

pub(super) fn authorized_services(
    context: &ToolContext,
) -> Result<&ToolFileServices, SearchToolAccessError> {
    let authorized = context.authorized_effects.effects.iter().any(|effect| {
        matches!(
            effect,
            ToolEffect::ReadFile { path, scope }
                if scope == "workspace" && Path::new(path) == context.workspace_root
        )
    });
    if !authorized {
        return Err(SearchToolAccessError::AuthorizationMismatch);
    }
    services(context).map_err(|_| SearchToolAccessError::ServicesUnavailable)
}

pub(super) fn access_error(error: SearchToolAccessError) -> ToolExecutionResult {
    match error {
        SearchToolAccessError::AuthorizationMismatch => execution_error(
            "TOOL_SEARCH_PATH_NOT_AUTHORIZED",
            "Workspace search authorization changed before execution.",
            false,
        ),
        SearchToolAccessError::ServicesUnavailable => execution_error(
            "TOOL_SEARCH_UNAVAILABLE",
            "Trusted workspace search services are unavailable.",
            false,
        ),
    }
}

pub(super) fn search_error(error: SearchError) -> ToolExecutionResult {
    let suggestion = match error {
        SearchError::RipgrepUnavailable => {
            Some("Reinstall the application so its bundled search executable is restored.")
        }
        SearchError::InvalidInput(_) => Some("Correct the search arguments and retry."),
        SearchError::PathNotAuthorized => {
            Some("Choose an existing path inside the current workspace.")
        }
        SearchError::PathNotDirectory => {
            Some("Choose an existing directory inside the current workspace.")
        }
        SearchError::PathNotSearchable => {
            Some("Choose an existing regular file or directory inside the current workspace.")
        }
        SearchError::TimedOut => Some("Narrow the pattern or search path and retry."),
        _ => None,
    };
    ToolExecutionResult::Error {
        error: ToolExecutionError {
            code: error.code().to_string(),
            message: error.to_string(),
            recoverable: error.retryable(),
            suggestion: suggestion.map(str::to_string),
            retry_after_ms: None,
            details: None,
        },
        model_content: Some(format!("Error: {error}")),
        ui_content: None,
        effects: None,
    }
}

pub(super) fn input_error(message: &str) -> ToolExecutionResult {
    execution_error("TOOL_SEARCH_INPUT_INVALID", message, true)
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
        model_content: Some(format!("Error: {message}")),
        ui_content: None,
        effects: None,
    }
}
