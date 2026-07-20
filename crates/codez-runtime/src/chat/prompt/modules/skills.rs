use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct SkillsModule;

use crate::chat::prompt::types::BoxFuture;

impl PromptModule for SkillsModule {
    fn id(&self) -> &'static str {
        "skills"
    }

    fn layer(&self) -> PromptLayer {
        PromptLayer::Context
    }

    fn priority(&self) -> i32 {
        5
    }

    fn build<'a>(&'a self, ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            let available = ctx.available_skills.as_deref().unwrap_or(&[]);
            let active = ctx.active_skills.as_deref().unwrap_or(&[]);
            if available.is_empty() && active.is_empty() {
                return None;
            }

            let has_activate_skill_tool = ctx.available_tools.as_deref().is_none_or(|tools| {
                tools
                    .iter()
                    .any(|t| t.name == "ActivateSkill" || t.name == "Skill")
            });

            let has_deactivate_skill_tool = ctx
                .available_tools
                .as_deref()
                .is_none_or(|tools| tools.iter().any(|t| t.name == "DeactivateSkill"));

            let mut lines = Vec::new();
            lines.push("<skills_instructions>".to_string());

            if has_activate_skill_tool {
                lines.push("When an available skill matches the request, activate it with ActivateSkill before doing the task. The legacy Skill tool is only a compatibility fallback.".to_string());
            } else {
                lines.push("Follow a skill only when its instructions are already present in the conversation.".to_string());
            }

            lines.push(
                "The latest <session_skill_state> block is authoritative for this conversation."
                    .to_string(),
            );
            lines.push("Continue following active skills without activating them again merely to reload their instructions.".to_string());
            lines.push("Do not use inactive skills unless the current request needs them. Never activate a disabled skill unless the user explicitly asks to re-enable it; then use ActivateSkill with force=true.".to_string());

            if has_deactivate_skill_tool {
                lines.push("When the user asks you to stop using a skill in this conversation, call DeactivateSkill with mode=\"disabled\" before continuing. Use mode=\"inactive\" only when a completed workflow may be needed again later.".to_string());
            }

            lines.push("If /<skill-name> has expanded into the current request, follow it directly; it is an explicit user activation and must not trigger another ActivateSkill call.\n".to_string());

            if !available.is_empty() {
                lines.push("Available skills:".to_string());
            }
            for skill in available {
                let identity = skill
                    .id
                    .as_deref()
                    .map_or_else(|| skill.name.clone(), |id| format!("{} ({id})", skill.name));
                match skill.description.as_deref() {
                    Some(description) if !description.trim().is_empty() => {
                        lines.push(format!("- {identity}: {description}"));
                    }
                    _ => lines.push(format!("- {identity}")),
                }
            }
            if !active.is_empty() {
                lines.push("Active skills:".to_string());
            }
            for skill in active {
                match skill.description.as_deref() {
                    Some(description) if !description.trim().is_empty() => {
                        lines.push(format!("- {}: {}", skill.name, description));
                    }
                    _ => lines.push(format!("- {}", skill.name)),
                }
            }

            lines.push("</skills_instructions>".to_string());

            Some(lines.join("\n"))
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::chat::prompt::types::{PromptContext, PromptSkillSummary, PromptToolSummary};

    use super::{PromptModule, SkillsModule};

    #[tokio::test]
    async fn prompt_lists_available_ids_and_active_skill_state_separately() {
        let context = PromptContext {
            workspace_root: None,
            model_id: "model".to_string(),
            model_display_name: "Model".to_string(),
            context_window_tokens: 8_192,
            session_id: Some("session-1".to_string()),
            api_format: Some("openai".to_string()),
            permission_mode: Some("auto".to_string()),
            thinking_enabled: Some(false),
            available_tools: Some(vec![PromptToolSummary {
                name: "ActivateSkill".to_string(),
                summary: "Activate a skill".to_string(),
            }]),
            deferred_tools: None,
            available_skills: Some(vec![PromptSkillSummary {
                id: Some("global-review".to_string()),
                name: "review".to_string(),
                description: Some("Review safely".to_string()),
            }]),
            active_skills: Some(vec![PromptSkillSummary {
                id: None,
                name: "review".to_string(),
                description: None,
            }]),
            todo_state: None,
            global_rules: None,
            workspace_rules: None,
            directory_rules: None,
            git_status: None,
            now: None,
            agent: None,
        };

        let prompt = SkillsModule
            .build(&context)
            .await
            .expect("skills prompt must be emitted");

        assert!(
            prompt.contains("review (global-review): Review safely")
                && prompt.contains("Active skills:\n- review")
        );
    }
}
