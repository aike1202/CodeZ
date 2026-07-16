use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct GitStatusModule;

use crate::chat::prompt::types::BoxFuture;

impl PromptModule for GitStatusModule {
    fn id(&self) -> &'static str {
        "git-status"
    }

    fn layer(&self) -> PromptLayer {
        PromptLayer::Context
    }

    fn priority(&self) -> i32 {
        4
    }

    fn build<'a>(&'a self, ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            let snapshot = ctx.git_status.as_deref().unwrap_or("");
            if snapshot.is_empty() {
                Some(
                    "<git_status>not a git repository or status unavailable</git_status>"
                        .to_string(),
                )
            } else {
                Some(format!("<git_status>\n{}\n</git_status>", snapshot))
            }
        })
    }
}
