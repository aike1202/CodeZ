use chrono::{SecondsFormat, Utc};
use codez_core::context::{
    InvokedSkillContextEntry, PostCompactionSkillContext, SessionSkillState,
};

pub struct SkillContextRestorer;

impl SkillContextRestorer {
    pub fn restore(
        states: &[SessionSkillState],
        _token_budget: u32,
        source_sequence: u32,
    ) -> Option<PostCompactionSkillContext> {
        let active_states: Vec<_> = states.iter().filter(|s| s.status == "active").collect();
        if active_states.is_empty() {
            return None;
        }

        let mut content = String::from("Active Skill States:\n");
        let mut references = Vec::new();

        for state in active_states {
            content.push_str(&format!(
                "- {}: {}\n",
                state.name,
                state.content.as_deref().unwrap_or("")
            ));
            references.push(InvokedSkillContextEntry {
                name: state.name.clone(),
                content: state.content.as_deref().unwrap_or("").to_string(),
                invoked_sequence: state.updated_sequence,
            });
        }

        Some(PostCompactionSkillContext {
            content,
            skills: references,
            created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            source_sequence: Some(source_sequence),
        })
    }
}
