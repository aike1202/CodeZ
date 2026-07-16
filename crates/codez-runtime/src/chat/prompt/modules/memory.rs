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

    fn build<'a>(&'a self, ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            let mem_dir = ctx.workspace_root.join(".agents").join("brain");
            let path_str = mem_dir.to_string_lossy();

            Some(format!(
                r#"# Memory

Persistent memory is stored at `{}`. Save only durable user preferences, corrections, project constraints, or external references that will matter in future conversations. Use one focused markdown file per memory and keep a one-line pointer in `MEMORY.md`; update existing memories instead of duplicating them.

Do not store facts already recorded by the repository. Treat memory as potentially stale and verify repository state before relying on it."#,
                path_str
            ))
        })
    }
}
