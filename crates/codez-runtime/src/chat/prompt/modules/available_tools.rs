use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct AvailableToolsModule;

use crate::chat::prompt::types::BoxFuture;

impl PromptModule for AvailableToolsModule {
    fn id(&self) -> &'static str {
        "available-tools"
    }

    fn layer(&self) -> PromptLayer {
        PromptLayer::Dynamic
    }

    fn priority(&self) -> i32 {
        2
    }

    fn build<'a>(&'a self, ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            let mut lines = Vec::new();

            if let Some(available) = &ctx.available_tools {
                if !available.is_empty() {
                    lines.push("<available_tools>".to_string());
                    lines.push("Tools available in this Provider round:".to_string());
                    for tool in available {
                        lines.push(format!("- {}: {}", tool.name, tool.summary));
                    }
                    lines.push("</available_tools>".to_string());
                }
            }

            if let Some(deferred) = &ctx.deferred_tools {
                if !deferred.is_empty() {
                    lines.push("<deferred_tools>".to_string());
                    lines.push(
                        "Use ToolSearch to activate one of these capabilities for the next turn:"
                            .to_string(),
                    );
                    for tool in deferred {
                        lines.push(format!("- {}: {}", tool.name, tool.summary));
                    }
                    lines.push("</deferred_tools>".to_string());
                }
            }
            if lines.is_empty() {
                None
            } else {
                Some(lines.join("\n"))
            }
        })
    }
}
