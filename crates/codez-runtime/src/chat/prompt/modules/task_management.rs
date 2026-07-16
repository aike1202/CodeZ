use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct TaskManagementModule;

const TEXT: &str = r#"# Task tracking

Task tools are optional bookkeeping. Use them when substantial work benefits from durable progress tracking or has meaningful dependencies. Do not create a task list for a simple request merely because it contains several actions or files. If you use tasks, keep statuses current and continue through executable work without repeatedly asking whether to proceed."#;

use crate::chat::prompt::types::BoxFuture;

impl PromptModule for TaskManagementModule {
    fn id(&self) -> &'static str {
        "task-management"
    }

    fn layer(&self) -> PromptLayer {
        PromptLayer::Dynamic
    }

    fn priority(&self) -> i32 {
        6
    }

    fn is_enabled<'a>(&'a self, ctx: &'a PromptContext) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            ctx.available_tools.as_ref().is_none_or(|tools| {
                tools
                    .iter()
                    .any(|t| t.name == "TaskCreate" || t.name == "TaskUpdate")
            })
        })
    }

    fn build<'a>(&'a self, _ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move { Some(TEXT.to_string()) })
    }
}
