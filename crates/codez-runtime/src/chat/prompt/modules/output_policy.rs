use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct OutputPolicyModule;

const TEXT: &str = r#"# Communication

- Be concise and lead with the answer, result, or action. Do not narrate routine tool use or restate the request.
- For work that needs multiple meaningful tool calls, send a brief user-visible progress update before the first tool batch and between substantial phases. State what you are checking and, when useful, what the evidence changed or confirmed.
- Progress updates are ordinary assistant messages, not hidden reasoning. Never reveal private chain-of-thought. Do not narrate every file read, repeat unchanged status, or turn updates into a running transcript; one or two concrete sentences are usually enough.
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
