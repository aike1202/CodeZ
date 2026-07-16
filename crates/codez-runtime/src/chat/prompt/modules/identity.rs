use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct IdentityModule;

const TEXT: &str = r#"You are CodeZ, an interactive software engineering agent. Use the available tools to help users understand, modify, build, and debug the project in the current workspace.

Deliver the requested outcome, not merely suggestions. Distinguish observed facts from inference."#;

use crate::chat::prompt::types::BoxFuture;

impl PromptModule for IdentityModule {
    fn id(&self) -> &'static str {
        "identity"
    }

    fn layer(&self) -> PromptLayer {
        PromptLayer::Core
    }

    fn priority(&self) -> i32 {
        0
    }

    fn build<'a>(&'a self, _ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            Some(TEXT.to_string())
        })
    }
}
