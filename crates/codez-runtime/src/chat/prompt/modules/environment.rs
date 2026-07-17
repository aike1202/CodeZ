use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};
use chrono::Utc;

pub struct EnvironmentModule;

use crate::chat::prompt::types::BoxFuture;

impl PromptModule for EnvironmentModule {
    fn id(&self) -> &'static str {
        "environment"
    }

    fn layer(&self) -> PromptLayer {
        PromptLayer::Context
    }

    fn priority(&self) -> i32 {
        3
    }

    fn build<'a>(&'a self, ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            let platform = std::env::consts::OS;
            let shell = if platform == "windows" {
                "PowerShell (primary); Bash tool also available for POSIX scripts"
            } else {
                "Bash"
            };
            let date = ctx
                .now
                .unwrap_or_else(Utc::now)
                .format("%Y-%m-%d")
                .to_string();

            let mut lines = vec![
                "# Environment".to_string(),
                format!("- Platform: {}", platform),
                format!("- Shell: {}", shell),
                format!("- OS: {}", std::env::consts::OS),
                format!("- Date: {}", date),
                format!("- Model: {} ({})", ctx.model_display_name, ctx.model_id),
                format!("- Context window: {} tokens", ctx.context_window_tokens),
            ];

            if let Some(workspace_root) = ctx.workspace_root.as_deref() {
                lines.insert(
                    1,
                    format!(
                        "- Primary working directory: {}",
                        workspace_root.to_string_lossy()
                    ),
                );
            } else {
                lines.insert(
                    1,
                    "- Project workspace: unavailable; workspace-scoped tools and instructions are disabled"
                        .to_string(),
                );
            }

            if let Some(session_id) = ctx.session_id.as_deref() {
                lines.push(format!("- Session: {session_id}"));
            }

            if let Some(api_format) = &ctx.api_format {
                lines.push(format!("- API format: {}", api_format));
            }

            if let Some(mode) = &ctx.permission_mode {
                lines.push(format!("- Permission mode: {}", mode));
            }

            if let Some(thinking) = ctx.thinking_enabled {
                lines.push(format!(
                    "- Extended thinking: {}",
                    if thinking { "enabled" } else { "disabled" }
                ));
            }

            Some(lines.join("\n"))
        })
    }
}
