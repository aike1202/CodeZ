use std::sync::Arc;

use async_trait::async_trait;
use codez_core::{AppError, CancellationToken};
use thiserror::Error;
use tokio::sync::Mutex;

use crate::agent::state::{AgentState, AgentStatus};

const MAX_IDENTIFIER_BYTES: usize = 512;

/// Bounded execution policy for one agent run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentLoopLimits {
    max_steps: usize,
}

impl AgentLoopLimits {
    /// Creates limits that prevent a run from looping indefinitely.
    ///
    /// # Errors
    ///
    /// Returns [`AgentLoopError::InvalidStepLimit`] when `max_steps` is zero.
    pub fn new(max_steps: usize) -> Result<Self, AgentLoopError> {
        if max_steps == 0 {
            return Err(AgentLoopError::InvalidStepLimit);
        }
        Ok(Self { max_steps })
    }

    #[must_use]
    pub const fn max_steps(self) -> usize {
        self.max_steps
    }
}

impl Default for AgentLoopLimits {
    fn default() -> Self {
        Self { max_steps: 100 }
    }
}

/// Immutable context passed to exactly one concrete agent-step executor.
#[derive(Debug, Clone)]
pub struct AgentStepContext {
    pub session_id: String,
    pub task_id: String,
    pub step_number: usize,
    pub cancellation: CancellationToken,
}

/// Result selected by a concrete agent-step executor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentStepOutcome {
    /// The executor produced progress and the run may accept another step.
    Continue,
    /// The executor finished the assigned run successfully.
    Complete,
}

/// Executes the model/tool work for a single state-machine step.
///
/// The loop owns admission, cancellation, and terminal state transitions;
/// implementations only perform the actual model or tool work.
#[async_trait]
pub trait AgentStepExecutor: Send + Sync {
    async fn execute_step(&self, context: AgentStepContext) -> Result<AgentStepOutcome, AppError>;
}

/// Errors emitted by the agent run state machine.
#[derive(Debug, Error)]
pub enum AgentLoopError {
    #[error("agent {field} must be non-empty, bounded, and free of control characters")]
    InvalidIdentifier { field: &'static str },
    #[error("agent runs require a non-zero step limit")]
    InvalidStepLimit,
    #[error("agent cannot run a step while it is {status:?}")]
    InvalidState { status: AgentStatus },
    #[error("agent run exceeded its configured {max_steps}-step limit")]
    StepLimitExceeded { max_steps: usize },
    #[error("agent step execution failed")]
    Execution(#[source] AppError),
}

struct LoopState {
    agent: AgentState,
    active_step_cancellation: Option<CancellationToken>,
}

/// Serializes one agent run around a concrete model/tool executor.
pub struct AgentLoop {
    state: Arc<Mutex<LoopState>>,
    executor: Arc<dyn AgentStepExecutor>,
    limits: AgentLoopLimits,
}

impl AgentLoop {
    /// Creates a run with the default bounded step policy.
    ///
    /// # Errors
    ///
    /// Returns [`AgentLoopError::InvalidIdentifier`] when either caller-owned
    /// identifier is unsafe to store or report.
    pub fn new(
        session_id: String,
        task_id: String,
        executor: Arc<dyn AgentStepExecutor>,
    ) -> Result<Self, AgentLoopError> {
        Self::with_limits(session_id, task_id, executor, AgentLoopLimits::default())
    }

    /// Creates a run with an explicit maximum number of model/tool steps.
    ///
    /// # Errors
    ///
    /// Returns [`AgentLoopError::InvalidIdentifier`] for unsafe identifiers.
    pub fn with_limits(
        session_id: String,
        task_id: String,
        executor: Arc<dyn AgentStepExecutor>,
        limits: AgentLoopLimits,
    ) -> Result<Self, AgentLoopError> {
        validate_identifier(&session_id, "session ID")?;
        validate_identifier(&task_id, "task ID")?;
        Ok(Self {
            state: Arc::new(Mutex::new(LoopState {
                agent: AgentState::new(session_id, task_id),
                active_step_cancellation: None,
            })),
            executor,
            limits,
        })
    }

    /// Runs one executor step without holding the state lock across `.await`.
    ///
    /// A completed or failed run remains terminal. A stopped run must be
    /// explicitly resumed before it can execute another step.
    pub async fn run_step(&self) -> Result<AgentStatus, AgentLoopError> {
        let context = {
            let mut state = self.state.lock().await;
            match state.agent.status {
                AgentStatus::Completed | AgentStatus::Failed => {
                    return Ok(state.agent.status.clone());
                }
                AgentStatus::Paused | AgentStatus::Running => {
                    return Err(AgentLoopError::InvalidState {
                        status: state.agent.status.clone(),
                    });
                }
                AgentStatus::Idle => {}
            }

            let Some(step_number) = state.agent.steps_completed.checked_add(1) else {
                state.agent.status = AgentStatus::Failed;
                state.agent.current_error = Some("Agent step counter overflowed".to_string());
                return Err(AgentLoopError::StepLimitExceeded {
                    max_steps: self.limits.max_steps(),
                });
            };
            if step_number > self.limits.max_steps() {
                state.agent.status = AgentStatus::Failed;
                state.agent.current_error = Some(format!(
                    "Agent run exceeded the {}-step limit",
                    self.limits.max_steps()
                ));
                return Err(AgentLoopError::StepLimitExceeded {
                    max_steps: self.limits.max_steps(),
                });
            }

            let cancellation = CancellationToken::new();
            state.agent.status = AgentStatus::Running;
            state.agent.steps_completed = step_number;
            state.agent.current_error = None;
            state.active_step_cancellation = Some(cancellation.clone());
            AgentStepContext {
                session_id: state.agent.session_id.clone(),
                task_id: state.agent.task_id.clone(),
                step_number,
                cancellation,
            }
        };

        let result = self.executor.execute_step(context).await;
        let mut state = self.state.lock().await;
        state.active_step_cancellation = None;
        if state.agent.status == AgentStatus::Paused {
            return Ok(AgentStatus::Paused);
        }

        match result {
            Ok(AgentStepOutcome::Continue) => {
                state.agent.status = AgentStatus::Idle;
                Ok(AgentStatus::Idle)
            }
            Ok(AgentStepOutcome::Complete) => {
                state.agent.status = AgentStatus::Completed;
                Ok(AgentStatus::Completed)
            }
            Err(error) => {
                state.agent.status = AgentStatus::Failed;
                state.agent.current_error = Some(error.public_message().to_string());
                Err(AgentLoopError::Execution(error))
            }
        }
    }

    /// Returns a stable snapshot without exposing mutable state.
    pub async fn snapshot(&self) -> AgentState {
        self.state.lock().await.agent.clone()
    }

    pub async fn current_status(&self) -> AgentStatus {
        self.state.lock().await.agent.status.clone()
    }

    /// Cancels the active step and transitions it to a resumable paused state.
    pub async fn stop(&self) -> bool {
        let mut state = self.state.lock().await;
        if state.agent.status != AgentStatus::Running {
            return false;
        }
        if let Some(cancellation) = state.active_step_cancellation.as_ref() {
            cancellation.cancel();
        }
        state.agent.status = AgentStatus::Paused;
        true
    }

    /// Allows a previously stopped run to execute a new step.
    pub async fn resume(&self) -> Result<AgentStatus, AgentLoopError> {
        let mut state = self.state.lock().await;
        if state.agent.status != AgentStatus::Paused {
            return Err(AgentLoopError::InvalidState {
                status: state.agent.status.clone(),
            });
        }
        state.agent.status = AgentStatus::Idle;
        Ok(AgentStatus::Idle)
    }
}

fn validate_identifier(value: &str, field: &'static str) -> Result<(), AgentLoopError> {
    if value.trim().is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(AgentLoopError::InvalidIdentifier { field });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, sync::Arc};

    use async_trait::async_trait;
    use codez_core::{AppError, CancellationToken};
    use tokio::sync::{Mutex, Notify};

    use super::{
        AgentLoop, AgentLoopError, AgentLoopLimits, AgentStepContext, AgentStepExecutor,
        AgentStepOutcome,
    };
    use crate::agent::state::AgentStatus;

    #[derive(Clone, Copy)]
    enum ScriptedOutcome {
        Continue,
        Complete,
        Fail,
    }

    struct ScriptedExecutor {
        outcomes: Mutex<VecDeque<ScriptedOutcome>>,
    }

    impl ScriptedExecutor {
        fn new(outcomes: impl IntoIterator<Item = ScriptedOutcome>) -> Self {
            Self {
                outcomes: Mutex::new(outcomes.into_iter().collect()),
            }
        }
    }

    #[async_trait]
    impl AgentStepExecutor for ScriptedExecutor {
        async fn execute_step(
            &self,
            _context: AgentStepContext,
        ) -> Result<AgentStepOutcome, AppError> {
            match self
                .outcomes
                .lock()
                .await
                .pop_front()
                .unwrap_or(ScriptedOutcome::Complete)
            {
                ScriptedOutcome::Continue => Ok(AgentStepOutcome::Continue),
                ScriptedOutcome::Complete => Ok(AgentStepOutcome::Complete),
                ScriptedOutcome::Fail => Err(AppError::external(
                    "The agent step failed",
                    "scripted executor failure",
                    false,
                )),
            }
        }
    }

    struct WaitingExecutor {
        started: Arc<Notify>,
    }

    #[async_trait]
    impl AgentStepExecutor for WaitingExecutor {
        async fn execute_step(
            &self,
            context: AgentStepContext,
        ) -> Result<AgentStepOutcome, AppError> {
            self.started.notify_one();
            context.cancellation.cancelled().await;
            Ok(AgentStepOutcome::Continue)
        }
    }

    fn loop_with(outcomes: impl IntoIterator<Item = ScriptedOutcome>) -> AgentLoop {
        AgentLoop::new(
            "session-1".to_string(),
            "task-1".to_string(),
            Arc::new(ScriptedExecutor::new(outcomes)),
        )
        .expect("valid fixture identifiers must construct an agent loop")
    }

    #[tokio::test]
    async fn step_executor_controls_idle_and_completed_transitions() {
        let agent = loop_with([ScriptedOutcome::Continue, ScriptedOutcome::Complete]);

        assert!(matches!(agent.run_step().await, Ok(AgentStatus::Idle)));
        assert!(matches!(
            agent.run_step().await,
            Ok(AgentStatus::Completed)
        ));
    }

    #[tokio::test]
    async fn failed_executor_records_only_the_public_error_message() {
        let agent = loop_with([ScriptedOutcome::Fail]);

        let error = agent.run_step().await.expect_err("fixture step must fail");

        assert!(matches!(error, AgentLoopError::Execution(_)));
        assert_eq!(agent.snapshot().await.current_error.as_deref(), Some("The agent step failed"));
    }

    #[tokio::test]
    async fn configured_step_limit_transitions_the_run_to_failed() {
        let executor = Arc::new(ScriptedExecutor::new([ScriptedOutcome::Continue]));
        let limits = AgentLoopLimits::new(1).expect("one step must be a valid limit");
        let agent = AgentLoop::with_limits(
            "session-1".to_string(),
            "task-1".to_string(),
            executor,
            limits,
        )
        .expect("valid fixture identifiers must construct an agent loop");

        let first = agent.run_step().await;
        let second = agent.run_step().await;

        assert!(matches!(first, Ok(AgentStatus::Idle)));
        assert!(matches!(second, Err(AgentLoopError::StepLimitExceeded { .. })));
        assert_eq!(agent.current_status().await, AgentStatus::Failed);
    }

    #[tokio::test]
    async fn stopping_an_active_step_preserves_the_paused_state() {
        let started = Arc::new(Notify::new());
        let agent = Arc::new(
            AgentLoop::new(
                "session-1".to_string(),
                "task-1".to_string(),
                Arc::new(WaitingExecutor {
                    started: Arc::clone(&started),
                }),
            )
            .expect("valid fixture identifiers must construct an agent loop"),
        );
        let notified = started.notified();
        let running = {
            let agent = Arc::clone(&agent);
            tokio::spawn(async move { agent.run_step().await })
        };

        notified.await;
        assert!(agent.stop().await);
        let result = running.await.expect("agent task must join");

        assert!(matches!(result, Ok(AgentStatus::Paused)));
    }

    #[test]
    fn cancellation_token_context_is_sendable() {
        fn accepts_token(_: CancellationToken) {}

        accepts_token(CancellationToken::new());
    }
}
