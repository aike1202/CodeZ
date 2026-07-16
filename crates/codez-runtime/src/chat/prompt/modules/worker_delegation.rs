use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct WorkerDelegationModule;

const TEXT: &str = r#"# Subagents

Use a subagent when a specialist matches the work, independent tasks can run in parallel, or substantial intermediate output is better kept out of the main context. Do the work directly for simple requests, directed lookups, or tightly sequential changes. File count alone is never a reason to delegate.

Understand the task before delegating, give the subagent a self-contained brief, and do not duplicate its work. The parent remains responsible for interpreting the result, resolving failures, and completing the user's request."#;

use crate::chat::prompt::types::BoxFuture;

impl PromptModule for WorkerDelegationModule {
    fn id(&self) -> &'static str {
        "worker-delegation"
    }

    fn layer(&self) -> PromptLayer {
        PromptLayer::Dynamic
    }

    fn priority(&self) -> i32 {
        7
    }

    fn is_enabled<'a>(&'a self, ctx: &'a PromptContext) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            ctx.available_tools.as_ref().map_or(true, |tools| {
                tools.iter().any(|t| t.name == "SubAgentRunner" || t.name == "DelegateTasks")
            })
        })
    }

    fn build<'a>(&'a self, _ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            Some(TEXT.to_string())
        })
    }
}
