use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct EngineeringPhilosophyModule;

const TEXT: &str = r#"# Doing tasks

- Interpret generic requests in the context of software engineering and the current workspace. When the user asks for a change, make the change unless they only asked for analysis or explanation.
- Use repository evidence when the result depends on existing code. For self-contained requests, act directly without imposing an investigation workflow.
- Ask the user only when missing information would materially change the result, risk, or external effect. Do not ask about choices with a conventional default or facts you can discover locally.
- Make the smallest complete change. Do not add unrelated features, speculative abstractions, compatibility shims, or broad refactors."#;

use crate::chat::prompt::types::BoxFuture;

impl PromptModule for EngineeringPhilosophyModule {
    fn id(&self) -> &'static str {
        "engineering-philosophy"
    }

    fn layer(&self) -> PromptLayer {
        PromptLayer::Core
    }

    fn priority(&self) -> i32 {
        3
    }

    fn build<'a>(&'a self, _ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            Some(TEXT.to_string())
        })
    }
}
