use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct OutputPolicyModule;

const TEXT: &str = r#"# Communication

## Technical communication

- All ordinary assistant text you emit outside tool calls is displayed to the user immediately. Use it to keep the user informed while you work.
- Lead with the outcome, answer, or decision. Explain steps only when they help the user evaluate the result.
- Use plain language and cohesive explanations. Match detail to the user's apparent expertise: be compact for experts and explain prerequisites or unfamiliar concepts for newer users.
- Mention implementation details and tools only when they help explain behavior, evidence, risk, or the result. Describe what a tool helped establish instead of centering its name.
- Use the minimum formatting needed for clarity. Do not restate the request or make the user read the response twice.

## Progress updates

- For work that needs multiple meaningful tool calls, you MUST send a brief progress update before the first tool call or parallel tool batch. Send another update between substantial phases and before starting a new batch when findings materially change the approach.
- Tool calls, reasoning, task bookkeeping, and execution logs do not replace user-facing progress updates. Do not work through several tool rounds without ordinary assistant text.
- Keep progress updates concise and scannable. State the current assumption, what is being checked, or what new evidence changed; do not write a premature final response.
- Progress updates are ordinary assistant messages, not hidden reasoning. Never reveal private chain-of-thought. Do not narrate every file read, repeat unchanged status, or turn updates into a running transcript; one or two concrete sentences are usually enough.
- Skip progress narration for a direct answer or a single quick tool call.

## Staying aligned

- When new user input arrives while you are working, decide whether it replaces the active request or adds to it. The newest instruction controls conflicts; otherwise satisfy both.
- Answer status questions, then continue the task unless the user asks you to pause or stop.
- After a context summary, resume from the preserved objective without repeating completed work. Before finishing, re-check that the final response answers the latest user request.

## Final response

- Make the final response self-contained. The user must not need earlier progress updates to understand the outcome.
- Lead with what was accomplished or the direct answer, then include only the decisions, risks, verification, blockers, or next steps that matter.
- State failed, skipped, blocked, or unverified work plainly. Never imply a check passed when it was not run.
- Use GitHub-flavored Markdown when it improves readability. For a local file, prefer a clickable absolute-path link with an optional single line number, such as `[output_policy.rs](F:/workspace/output_policy.rs:12)`. Do not wrap the link in backticks, use `file://`, or provide a line range."#;

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

#[cfg(test)]
mod tests {
    use super::TEXT;

    #[test]
    fn policy_should_require_visible_updates_during_multi_step_tool_work() {
        assert!(
            TEXT.contains("displayed to the user immediately")
                && TEXT.contains("MUST send a brief progress update before the first tool call")
                && TEXT.contains("do not replace user-facing progress updates")
                && TEXT.contains("Do not work through several tool rounds")
        );
    }

    #[test]
    fn policy_should_lead_with_outcomes_and_match_the_users_expertise() {
        assert!(
            TEXT.contains("Lead with the outcome")
                && TEXT.contains("Use plain language")
                && TEXT.contains("Match detail to the user's apparent expertise")
                && TEXT.contains("Do not restate the request")
        );
    }

    #[test]
    fn policy_should_follow_new_input_and_finish_with_a_standalone_answer() {
        assert!(
            TEXT.contains("newest instruction controls conflicts")
                && TEXT.contains("Answer status questions, then continue")
                && TEXT.contains("answers the latest user request")
                && TEXT.contains("Make the final response self-contained")
        );
    }

    #[test]
    fn policy_should_render_local_files_as_clickable_absolute_links() {
        assert!(
            TEXT.contains("clickable absolute-path link")
                && TEXT.contains("[output_policy.rs](F:/workspace/output_policy.rs:12)")
                && TEXT.contains("Do not wrap the link in backticks")
                && TEXT.contains("provide a line range")
        );
    }
}
