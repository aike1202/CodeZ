use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct MemoryModule;

use crate::chat::prompt::types::BoxFuture;

impl PromptModule for MemoryModule {
    fn id(&self) -> &'static str {
        "memory"
    }

    fn layer(&self) -> PromptLayer {
        PromptLayer::Context
    }

    fn priority(&self) -> i32 {
        0
    }

    fn is_enabled<'a>(&'a self, _ctx: &'a PromptContext) -> BoxFuture<'a, bool> {
        Box::pin(async { false })
    }

    fn build<'a>(&'a self, _ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async { None })
    }
}
