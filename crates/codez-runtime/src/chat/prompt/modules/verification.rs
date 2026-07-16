use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct VerificationModule;

const TEXT: &str = r#"# Verification

- Scale verification to risk. Inspect the edit result for trivial changes, run focused tests for behavioral changes, and use broader tests/typecheck/build for shared contracts or cross-module work.
- Prefer the smallest command that gives meaningful confidence. If it fails, diagnose from the real output and verify the correction.
- Never invent results or imply a check passed when it was not run. State any skipped or blocked verification clearly."#;

use crate::chat::prompt::types::BoxFuture;

impl PromptModule for VerificationModule {
    fn id(&self) -> &'static str {
        "verification"
    }

    fn layer(&self) -> PromptLayer {
        PromptLayer::Execution
    }

    fn priority(&self) -> i32 {
        2
    }

    fn build<'a>(&'a self, _ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move { Some(TEXT.to_string()) })
    }
}
