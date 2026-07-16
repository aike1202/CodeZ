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
            let active = ctx.active_skills.as_deref().unwrap_or(&[]);
            if active.is_empty() {
                return None;
            }

            let has_activate_skill_tool = ctx.available_tools.as_deref().map_or(true, |tools| {
                tools.iter().any(|t| t.name == "ActivateSkill" || t.name == "Skill")
            });

            let has_deactivate_skill_tool = ctx.available_tools.as_deref().map_or(true, |tools| {
                tools.iter().any(|t| t.name == "DeactivateSkill")
            });

            let mut lines = Vec::new();
            lines.push("<skills_instructions>".to_string());
            
            if has_activate_skill_tool {
                lines.push("When an available skill matches the request, activate it with ActivateSkill before doing the task. The legacy Skill tool is only a compatibility fallback.".to_string());
            } else {
                lines.push("Follow a skill only when its instructions are already present in the conversation.".to_string());
            }

            lines.push("The latest <session_skill_state> block is authoritative for this conversation.".to_string());
            lines.push("Continue following active skills without activating them again merely to reload their instructions.".to_string());
            lines.push("Do not use inactive skills unless the current request needs them. Never activate a disabled skill unless the user explicitly asks to re-enable it; then use ActivateSkill with force=true.".to_string());

            if has_deactivate_skill_tool {
                lines.push("When the user asks you to stop using a skill in this conversation, call DeactivateSkill with mode=\"disabled\" before continuing. Use mode=\"inactive\" only when a completed workflow may be needed again later.".to_string());
            }

            lines.push("If /<skill-name> has expanded into the current request, follow it directly; it is an explicit user activation and must not trigger another ActivateSkill call.\n".to_string());

            for skill in active {
                lines.push(format!("- {}: {}", skill.name, skill.description));
            }

            lines.push("</skills_instructions>".to_string());

            Some(lines.join("\n"))
        })
    }
}
