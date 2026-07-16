use codez_contracts::context::{SessionSkillState, NormalizedModelMessage, LedgerEventType};
use std::collections::HashMap;

pub fn apply_message_to_session_skill_states(
    current_states: Option<&[SessionSkillState]>,
    active_messages: &[NormalizedModelMessage],
    new_message: &NormalizedModelMessage,
) -> Vec<SessionSkillState> {
    let mut states = current_states.unwrap_or(&[]).to_vec();

    // TODO: parse tool results and model outputs to upsert skill states
    // In TS:
    // if (new_message.role === 'tool' && new_message.name === 'manage_skills' ...)

    states
}

pub fn derive_session_skill_states(messages: &[NormalizedModelMessage]) -> Vec<SessionSkillState> {
    let mut states = Vec::new();
    for msg in messages {
        states = apply_message_to_session_skill_states(Some(&states), messages, msg);
    }
    states
}
