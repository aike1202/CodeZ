use codez_core::context::{NormalizedModelMessage, SessionSkillState};

pub fn apply_message_to_session_skill_states(
    current_states: Option<&[SessionSkillState]>,
    _active_messages: &[NormalizedModelMessage],
    _new_message: &NormalizedModelMessage,
) -> Vec<SessionSkillState> {
    current_states.unwrap_or(&[]).to_vec()
}

pub fn derive_session_skill_states(messages: &[NormalizedModelMessage]) -> Vec<SessionSkillState> {
    let mut states = Vec::new();
    for msg in messages {
        states = apply_message_to_session_skill_states(Some(&states), messages, msg);
    }
    states
}
