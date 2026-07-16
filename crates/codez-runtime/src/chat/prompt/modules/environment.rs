use chrono::Utc;
use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

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
            let cwd = ctx.workspace_root.to_string_lossy();
            let date = ctx.now.unwrap_or_else(Utc::now).format("%Y-%m-%d").to_string();

            let mut lines = vec![
                "# Environment".to_string(),
                format!("- Primary working directory: {}", cwd),
                format!("- Platform: {}", platform),
                format!("- Shell: {}", shell),
                format!("- OS: {}", std::env::consts::OS),
                format!("- Date: {}", date),
                format!("- Model: {} ({})", ctx.model_display_name, ctx.model_id),
                format!("- Context window: {} tokens", ctx.context_window_tokens),
            ];

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
