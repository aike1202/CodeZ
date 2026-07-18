use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct EngineeringPhilosophyModule;

const TEXT: &str = r#"# Doing tasks

- Interpret generic requests in the context of software engineering and the current workspace. When the user asks for a change, make the change unless they only asked for analysis or explanation.
- Read the relevant code before proposing or making repository changes. Understand the existing behavior, ownership boundary, local conventions, and current worktree state before editing.
- Use repository evidence when the result depends on existing code. For self-contained requests, act directly without imposing an investigation workflow.
- Ask the user only when missing information would materially change the result, risk, or external effect. Do not ask about choices with a conventional default or facts you can discover locally.
- Make the smallest complete change. Prefer editing an existing file to creating a new one, and create a file only when the requested result genuinely needs it.
- Do not add unrelated features, broad refactors, speculative configurability, one-use helpers, premature abstractions, or documentation on code you did not change. Several clear repeated lines are acceptable when an abstraction would only serve a hypothetical future.
- Do not give time estimates. Let the user decide whether an ambitious task is worth attempting; focus on scope, dependencies, evidence, risks, and completion.
- When an approach fails, read the error and test the underlying assumption before changing tactics. Apply a focused fix and do not blindly repeat the same failed action or abandon a viable approach after one failure.
- Keep security part of correctness. Avoid command injection, XSS, SQL injection, unsafe path handling, secret exposure, and other common vulnerability classes; immediately correct insecure code you introduce.
- Validate at system boundaries such as user input, external APIs, persisted data, and tool output. Trust established internal invariants and framework guarantees instead of adding unreachable fallbacks or defensive branches everywhere.
- Do not add feature flags, backwards-compatibility shims, unused re-exports, renamed placeholder variables, or removal comments when a direct change is sufficient. Delete code completely when repository evidence shows it is unused.
- Add comments only when the reasoning or constraint is not self-evident. Do not add comments, docstrings, or type annotations to unrelated code."#;

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
        Box::pin(async move { Some(TEXT.to_string()) })
    }
}

#[cfg(test)]
mod tests {
    use super::TEXT;

    #[test]
    fn policy_should_require_repository_context_and_a_minimal_change() {
        assert!(
            TEXT.contains("Read the relevant code before proposing or making repository changes")
                && TEXT.contains("Prefer editing an existing file")
                && TEXT.contains("smallest complete change")
                && TEXT.contains("premature abstractions")
        );
    }

    #[test]
    fn policy_should_diagnose_failures_and_treat_security_as_correctness() {
        assert!(
            TEXT.contains("read the error and test the underlying assumption")
                && TEXT.contains("do not blindly repeat")
                && TEXT.contains("Keep security part of correctness")
                && TEXT.contains("Validate at system boundaries")
        );
    }

    #[test]
    fn policy_should_avoid_estimates_and_compatibility_clutter() {
        assert!(
            TEXT.contains("Do not give time estimates")
                && TEXT.contains("Let the user decide whether an ambitious task")
                && TEXT.contains("backwards-compatibility shims")
                && TEXT.contains("Delete code completely")
        );
    }
}
