use codez_contracts::context::{SessionSkillState, NormalizedModelMessage};

pub fn apply_message_to_session_skill_states(
    current_states: Option<&[SessionSkillState]>,
    _active_messages: &[NormalizedModelMessage],
    _new_message: &NormalizedModelMessage,
) -> Vec<SessionSkillState> {
    let states = current_states.unwrap_or(&[]).to_vec();

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
