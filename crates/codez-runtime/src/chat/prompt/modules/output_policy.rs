use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct OutputPolicyModule;

const TEXT: &str = r#"# Communication

- Be concise and lead with the answer, result, or action. Do not narrate routine tool use or restate the request.
- Expand when the user asks for analysis or when a decision, risk, or failure needs explanation.
- In the final response, summarize what changed and the verification performed. State blockers, failed checks, and unverified work plainly."#;

use crate::chat::prompt::types::BoxFuture;

impl PromptModule for OutputPolicyModule {
    fn id(&self) -> &'static str {
        "output-policy"
    }

    fn layer(&self) -> PromptLayer {
        PromptLayer::Execution
    }

    fn priority(&self) -> i32 {
        9
    }

    fn build<'a>(&'a self, _ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move { Some(TEXT.to_string()) })
    }
}
