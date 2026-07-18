use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct SubAgentsModule;

use crate::chat::prompt::types::BoxFuture;

impl PromptModule for SubAgentsModule {
    fn id(&self) -> &'static str {
        "subagents"
    }

    fn layer(&self) -> PromptLayer {
        PromptLayer::Dynamic
    }

    fn priority(&self) -> i32 {
        3
    }

    fn is_enabled<'a>(&'a self, _ctx: &'a PromptContext) -> BoxFuture<'a, bool> {
        Box::pin(async move { false })
    }

    fn build<'a>(&'a self, _ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async { None })
    }
}
