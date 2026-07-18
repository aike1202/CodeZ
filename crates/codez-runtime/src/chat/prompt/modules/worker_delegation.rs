use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct WorkerDelegationModule;

const TEXT: &str = r#"# Subagents

Subagents are optional. Do the work directly for simple questions, known paths, directed lookups, one-symbol searches, and tightly sequential changes. File count and Task count are never reasons to delegate.

Before spawning, understand the problem and provide a self-contained brief with the goal, known facts, questions, scope, exclusions, expected output, and depth. By default, spawn at most one Explore Agent. Spawn multiple Agents only when the user explicitly requests parallel work or at least two independent questions have clear parallel benefit and non-overlapping scope.

Never duplicate delegated work. Use Reviewer only after non-trivial implementation changes and primary verification, never for pure analysis or question answering. Prefer followup_task when a suitable completed Agent already exists. The parent remains responsible for interpreting results, resolving failures, and completing the user's request."#;

use crate::chat::prompt::types::BoxFuture;

impl PromptModule for WorkerDelegationModule {
    fn id(&self) -> &'static str {
        "worker-delegation"
    }

    fn layer(&self) -> PromptLayer {
        PromptLayer::Dynamic
    }

    fn priority(&self) -> i32 {
        7
    }

    fn is_enabled<'a>(&'a self, ctx: &'a PromptContext) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            ctx.available_tools.as_ref().is_none_or(|tools| {
                tools
                    .iter()
                    .any(|t| {
                        matches!(
                            t.name.as_str(),
                            "spawn_agent" | "SubAgentRunner" | "DelegateTasks"
                        )
                    })
            })
        })
    }

    fn build<'a>(&'a self, _ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move { Some(TEXT.to_string()) })
    }
}

#[cfg(test)]
mod tests {
    use crate::chat::prompt::types::{PromptContext, PromptModule, PromptToolSummary};

    use super::WorkerDelegationModule;

    fn context(tool: &str) -> PromptContext {
        PromptContext {
            workspace_root: None,
            model_id: "model".to_string(),
            model_display_name: "Model".to_string(),
            context_window_tokens: 8_192,
            session_id: None,
            api_format: None,
            permission_mode: None,
            thinking_enabled: None,
            available_tools: Some(vec![PromptToolSummary {
                name: tool.to_string(),
                summary: String::new(),
            }]),
            deferred_tools: None,
            available_agents: None,
            available_skills: None,
            active_skills: None,
            global_rules: None,
            workspace_rules: None,
            directory_rules: None,
            git_status: None,
            now: None,
        }
    }

    #[tokio::test]
    async fn delegation_policy_is_enabled_for_the_current_spawn_tool() {
        assert!(
            WorkerDelegationModule
                .is_enabled(&context("spawn_agent"))
                .await
        );
    }

    #[tokio::test]
    async fn delegation_policy_is_disabled_without_an_agent_tool() {
        assert!(
            !WorkerDelegationModule
                .is_enabled(&context("Read"))
                .await
        );
    }
}
