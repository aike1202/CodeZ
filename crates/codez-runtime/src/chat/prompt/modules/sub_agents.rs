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

    fn is_enabled<'a>(&'a self, ctx: &'a PromptContext) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            ctx.available_agents
                .as_ref()
                .is_some_and(|agents| !agents.is_empty())
        })
    }

    fn build<'a>(&'a self, ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            let agents = ctx.available_agents.as_ref()?;
            if agents.is_empty() {
                return None;
            }
            let mut lines = vec![
                "<available_agents>".to_string(),
                "Agent roles available through spawn_agent:".to_string(),
            ];
            for agent in agents {
                lines.push(format!("- {}: {}", agent.role, agent.description));
                lines.push("  Use when:".to_string());
                append_indented_lines(&mut lines, &agent.when_to_use, "    ");
                if let Some(when_not_to_use) = agent.when_not_to_use.as_deref() {
                    lines.push("  Do not use when:".to_string());
                    append_indented_lines(&mut lines, when_not_to_use, "    ");
                }
                if let Some(cost_hint) = agent.cost_hint.as_deref() {
                    lines.push(format!("  Budget: {cost_hint}"));
                }
            }
            lines.push("</available_agents>".to_string());
            Some(lines.join("\n"))
        })
    }
}

fn append_indented_lines(lines: &mut Vec<String>, value: &str, indent: &str) {
    lines.extend(
        value
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| format!("{indent}- {}", line.trim())),
    );
}

#[cfg(test)]
mod tests {
    use crate::chat::prompt::types::{PromptAgentSummary, PromptContext, PromptModule};

    use super::SubAgentsModule;

    #[tokio::test]
    async fn prompt_renders_use_and_avoid_rules_from_the_agent_catalog() {
        let context = PromptContext {
            workspace_root: None,
            model_id: "model".to_string(),
            model_display_name: "Model".to_string(),
            context_window_tokens: 8_192,
            session_id: None,
            api_format: None,
            permission_mode: None,
            thinking_enabled: None,
            available_tools: None,
            deferred_tools: None,
            available_agents: Some(vec![PromptAgentSummary {
                role: "Explore".to_string(),
                description: "Read-only research".to_string(),
                when_to_use: "Broad investigation".to_string(),
                when_not_to_use: Some("A direct read is enough".to_string()),
                cost_hint: Some("quick 6 rounds".to_string()),
            }]),
            available_skills: None,
            active_skills: None,
            todo_state: None,
            global_rules: None,
            workspace_rules: None,
            directory_rules: None,
            git_status: None,
            now: None,
        };

        let prompt = SubAgentsModule
            .build(&context)
            .await
            .expect("Agent catalog must render");

        assert!(
            prompt.contains("Broad investigation")
                && prompt.contains("A direct read is enough")
                && prompt.contains("quick 6 rounds")
        );
    }
}
