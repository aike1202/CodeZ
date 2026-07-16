use serde::{Deserialize, Serialize};

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

    pub fn transition_to(&mut self, new_state: ChatStreamState) -> Result<(), String> {
        // Simple state transition logic
        match (&self.state, &new_state) {
            (ChatStreamState::Starting, ChatStreamState::Running) => {
                self.state = new_state;
                Ok(())
            }
            (ChatStreamState::Starting, ChatStreamState::Failed) => {
                self.state = new_state;
                Ok(())
            }
            (ChatStreamState::Running, ChatStreamState::Stopping) => {
                self.state = new_state;
                Ok(())
            }
            (ChatStreamState::Running, ChatStreamState::Completed) => {
                self.state = new_state;
                Ok(())
            }
            (ChatStreamState::Running, ChatStreamState::Failed) => {
                self.state = new_state;
                Ok(())
            }
            (ChatStreamState::Running, ChatStreamState::Interrupted) => {
                self.state = new_state;
                Ok(())
            }
            (ChatStreamState::Stopping, ChatStreamState::Completed) => {
                self.state = new_state;
                Ok(())
            }
            (ChatStreamState::Stopping, ChatStreamState::Failed) => {
                self.state = new_state;
                Ok(())
            }
            (ChatStreamState::Stopping, ChatStreamState::Interrupted) => {
                self.state = new_state;
                Ok(())
            }
            _ => Err(format!(
                "Invalid state transition from {:?} to {:?}",
                self.state, new_state
            )),
        }
    }
}
