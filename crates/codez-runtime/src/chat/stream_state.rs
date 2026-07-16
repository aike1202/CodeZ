use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatStreamState {
    Starting,
    Running,
    Stopping,
    Completed,
    Failed,
    Interrupted,
}

impl ChatStreamState {
    #[must_use]
    pub const fn is_terminal(&self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Interrupted)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("invalid chat stream transition from {from:?} to {to:?}")]
pub struct ChatStreamTransitionError {
    pub from: ChatStreamState,
    pub to: ChatStreamState,
}

pub struct ChatStreamStateMachine {
    state: ChatStreamState,
}

impl ChatStreamStateMachine {
    pub fn new() -> Self {
        Self {
            state: ChatStreamState::Starting,
        }
    }

    pub fn current_state(&self) -> &ChatStreamState {
        &self.state
    }

    pub fn transition_to(
        &mut self,
        new_state: ChatStreamState,
    ) -> Result<(), ChatStreamTransitionError> {
        let allowed = matches!(
            (&self.state, &new_state),
            (
                ChatStreamState::Starting,
                ChatStreamState::Running
                    | ChatStreamState::Stopping
                    | ChatStreamState::Failed
                    | ChatStreamState::Interrupted
            ) | (
                ChatStreamState::Running,
                ChatStreamState::Stopping
                    | ChatStreamState::Completed
                    | ChatStreamState::Failed
                    | ChatStreamState::Interrupted
            ) | (
                ChatStreamState::Stopping,
                ChatStreamState::Failed | ChatStreamState::Interrupted
            )
        );
        if allowed {
            self.state = new_state;
            Ok(())
        } else {
            Err(ChatStreamTransitionError {
                from: self.state.clone(),
                to: new_state,
            })
        }
    }
}

impl Default for ChatStreamStateMachine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{ChatStreamState, ChatStreamStateMachine};

    #[test]
    fn terminal_state_should_reject_a_second_terminal_transition() {
        let mut state = ChatStreamStateMachine::new();
        state
            .transition_to(ChatStreamState::Running)
            .expect("run must start");
        state
            .transition_to(ChatStreamState::Completed)
            .expect("run must complete");

        let error = state
            .transition_to(ChatStreamState::Failed)
            .expect_err("a terminal state cannot transition again");

        assert_eq!(error.from, ChatStreamState::Completed);
    }

    #[test]
    fn starting_state_should_allow_stop_before_provider_registration() {
        let mut state = ChatStreamStateMachine::new();

        state
            .transition_to(ChatStreamState::Stopping)
            .expect("early cancellation must enter stopping");
        state
            .transition_to(ChatStreamState::Interrupted)
            .expect("stopping must terminate as interrupted");

        assert_eq!(state.current_state(), &ChatStreamState::Interrupted);
    }
}
