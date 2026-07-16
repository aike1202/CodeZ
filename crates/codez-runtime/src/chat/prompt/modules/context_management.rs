use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct ContextManagementModule;

const TEXT: &str = r#"# Context continuity

Conversation history may be summarized as it grows. Preserve the current objective, completed and pending work, modified files, decisions, and blockers. After a context trim, continue from the summary without repeating completed work and re-read source needed for the next change."#;

use crate::chat::prompt::types::BoxFuture;

impl PromptModule for ContextManagementModule {
    fn id(&self) -> &'static str {
        "context-management"
    }

    fn layer(&self) -> PromptLayer {
        PromptLayer::Context
    }

    fn priority(&self) -> i32 {
        1
    }

    fn build<'a>(&'a self, ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            let has_resume_tool = ctx.available_tools.as_ref().map_or(false, |tools| {
                tools.iter().any(|t| t.name == "update_resume_state")
            });

            if has_resume_tool {
                Some(format!(
                    "{}\n\nWhen warned that context is being trimmed, use `update_resume_state` to persist the active objective and handoff state.",
                    TEXT
                ))
            } else {
                Some(TEXT.to_string())
            }
        })
    }
}
