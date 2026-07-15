use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use codez_core::{AgentRunId, AppError, CancellationToken, ProcessId, SessionId, ToolCallId};

use crate::host::{ShutdownFuture, ShutdownHook, ShutdownPhase};

/// Application-owned cancellation root and active session registry.
pub struct CancellationTree {
    application: CancellationToken,
    accepting_sessions: AtomicBool,
    sessions: Mutex<HashMap<SessionId, CancellationToken>>,
}

impl std::fmt::Debug for CancellationTree {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CancellationTree")
            .field(
                "accepting_sessions",
                &self.accepting_sessions.load(Ordering::Acquire),
            )
            .field("application_cancelled", &self.application.is_cancelled())
            .field("active_sessions", &self.active_sessions())
            .finish()
    }
}

impl Default for CancellationTree {
    fn default() -> Self {
        Self::new()
    }
}

impl CancellationTree {
    /// Creates one accepting application cancellation root.
    #[must_use]
    pub fn new() -> Self {
        Self {
            application: CancellationToken::new(),
            accepting_sessions: AtomicBool::new(true),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Registers a unique active session below the application root.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] after shutdown stops admission or when the session ID
    /// is already active.
    pub fn open_session(&self, session_id: SessionId) -> Result<SessionCancellation, AppError> {
        if !self.accepting_sessions.load(Ordering::Acquire) {
            return Err(self.admission_error());
        }
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !self.accepting_sessions.load(Ordering::Acquire) {
            return Err(self.admission_error());
        }
        if sessions.contains_key(&session_id) {
            return Err(AppError::conflict("The session is already running"));
        }
        let cancellation = self.application.child_token();
        sessions.insert(session_id.clone(), cancellation.clone());
        Ok(SessionCancellation {
            session_id,
            cancellation,
        })
    }

    /// Stops accepting new sessions while existing work remains active.
    pub fn stop_accepting(&self) {
        let _sessions = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.accepting_sessions.store(false, Ordering::Release);
    }

    /// Cancels every session and all descendants.
    pub fn cancel_all(&self) {
        self.stop_accepting();
        self.application.cancel();
    }

    /// Cancels one active session and its agent/tool/process descendants.
    #[must_use]
    pub fn cancel_session(&self, session_id: &SessionId) -> bool {
        let cancellation = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session_id)
            .cloned();
        cancellation.is_some_and(|token| {
            token.cancel();
            true
        })
    }

    /// Removes a completed session and cancels any descendants it left behind.
    #[must_use]
    pub fn finish_session(&self, session_id: &SessionId) -> bool {
        let cancellation = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id);
        cancellation.is_some_and(|token| {
            token.cancel();
            true
        })
    }

    /// Returns the number of registered session owners.
    #[must_use]
    pub fn active_sessions(&self) -> usize {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }

    /// Returns a clone suitable for application-owned background tasks.
    #[must_use]
    pub fn application_token(&self) -> CancellationToken {
        self.application.clone()
    }

    fn admission_error(&self) -> AppError {
        if self.application.is_cancelled() {
            AppError::cancelled("The application is shutting down")
        } else {
            AppError::conflict("The application is no longer accepting sessions")
        }
    }
}

impl ShutdownHook for CancellationTree {
    fn name(&self) -> &'static str {
        "cancellation-tree"
    }

    fn run(&self, phase: ShutdownPhase) -> ShutdownFuture<'_> {
        Box::pin(async move {
            match phase {
                ShutdownPhase::StopAccepting => self.stop_accepting(),
                ShutdownPhase::Cancel => self.cancel_all(),
                ShutdownPhase::ForceCleanup | ShutdownPhase::Flush => {}
            }
            Ok(())
        })
    }
}

/// Cancellation owner for one active session.
#[derive(Debug, Clone)]
pub struct SessionCancellation {
    session_id: SessionId,
    cancellation: CancellationToken,
}

impl SessionCancellation {
    #[must_use]
    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    #[must_use]
    pub fn token(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    #[must_use]
    pub fn agent(&self, agent_run_id: AgentRunId) -> AgentCancellation {
        AgentCancellation {
            session_id: self.session_id.clone(),
            agent_run_id,
            cancellation: self.cancellation.child_token(),
        }
    }
}

/// Cancellation owner for one Agent run below a session.
#[derive(Debug, Clone)]
pub struct AgentCancellation {
    session_id: SessionId,
    agent_run_id: AgentRunId,
    cancellation: CancellationToken,
}

impl AgentCancellation {
    #[must_use]
    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    #[must_use]
    pub fn agent_run_id(&self) -> &AgentRunId {
        &self.agent_run_id
    }

    #[must_use]
    pub fn token(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    #[must_use]
    pub fn tool(&self, tool_call_id: ToolCallId) -> ToolCancellation {
        ToolCancellation {
            session_id: self.session_id.clone(),
            agent_run_id: self.agent_run_id.clone(),
            tool_call_id,
            cancellation: self.cancellation.child_token(),
        }
    }
}

/// Cancellation owner for one tool call below an Agent run.
#[derive(Debug, Clone)]
pub struct ToolCancellation {
    session_id: SessionId,
    agent_run_id: AgentRunId,
    tool_call_id: ToolCallId,
    cancellation: CancellationToken,
}

impl ToolCancellation {
    #[must_use]
    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    #[must_use]
    pub fn agent_run_id(&self) -> &AgentRunId {
        &self.agent_run_id
    }

    #[must_use]
    pub fn tool_call_id(&self) -> &ToolCallId {
        &self.tool_call_id
    }

    #[must_use]
    pub fn token(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    #[must_use]
    pub fn process(&self, process_id: ProcessId) -> ProcessCancellation {
        ProcessCancellation {
            session_id: self.session_id.clone(),
            agent_run_id: self.agent_run_id.clone(),
            tool_call_id: self.tool_call_id.clone(),
            process_id,
            cancellation: self.cancellation.child_token(),
        }
    }
}

/// Cancellation owner for one supervised process below a tool call.
#[derive(Debug, Clone)]
pub struct ProcessCancellation {
    session_id: SessionId,
    agent_run_id: AgentRunId,
    tool_call_id: ToolCallId,
    process_id: ProcessId,
    cancellation: CancellationToken,
}

impl ProcessCancellation {
    #[must_use]
    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    #[must_use]
    pub fn agent_run_id(&self) -> &AgentRunId {
        &self.agent_run_id
    }

    #[must_use]
    pub fn tool_call_id(&self) -> &ToolCallId {
        &self.tool_call_id
    }

    #[must_use]
    pub fn process_id(&self) -> &ProcessId {
        &self.process_id
    }

    #[must_use]
    pub fn token(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use codez_core::{AgentRunId, AppErrorKind, ProcessId, SessionId, ToolCallId};

    use super::CancellationTree;
    use crate::{ShutdownCoordinator, ShutdownPolicy};

    fn session_id(value: &str) -> SessionId {
        SessionId::parse(value).expect("fixture session ID must be valid")
    }

    #[test]
    fn cancellation_flows_downward_without_cancelling_owners() {
        let tree = CancellationTree::new();
        let session = tree
            .open_session(session_id("session-1"))
            .expect("session must open");
        let agent = session
            .agent(AgentRunId::parse("agent-1").expect("fixture Agent run ID must be valid"));
        let tool =
            agent.tool(ToolCallId::parse("tool-1").expect("fixture tool call ID must be valid"));
        let process =
            tool.process(ProcessId::parse("process-1").expect("fixture process ID must be valid"));

        tool.cancel();

        assert!(tool.is_cancelled() && process.is_cancelled());
        assert!(!agent.is_cancelled() && !session.is_cancelled());
    }

    #[test]
    fn session_cancellation_is_isolated_and_completion_releases_the_id() {
        let tree = CancellationTree::new();
        let first_id = session_id("session-1");
        let first = tree
            .open_session(first_id.clone())
            .expect("first session must open");
        let second = tree
            .open_session(session_id("session-2"))
            .expect("second session must open");

        assert!(tree.cancel_session(&first_id));
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        assert_eq!(
            tree.open_session(first_id.clone())
                .expect_err("an active session ID must remain unique")
                .kind(),
            AppErrorKind::Conflict
        );
        assert!(tree.finish_session(&first_id));
        assert!(tree.open_session(first_id).is_ok());
    }

    #[tokio::test]
    async fn shutdown_stops_admission_then_cancels_the_application_root() {
        let tree = Arc::new(CancellationTree::new());
        let session = tree
            .open_session(session_id("session-shutdown"))
            .expect("session must open before shutdown");
        let shutdown = ShutdownCoordinator::new(ShutdownPolicy::default());
        shutdown
            .register(Arc::clone(&tree) as Arc<dyn crate::ShutdownHook>)
            .expect("cancellation hook must register");
        assert!(shutdown.begin_shutdown());

        let report = shutdown.execute().await;

        assert!(report.failures.is_empty() && report.timed_out_phases.is_empty());
        assert!(session.is_cancelled() && tree.application_token().is_cancelled());
        assert_eq!(
            tree.open_session(session_id("too-late"))
                .expect_err("shutdown must reject new sessions")
                .kind(),
            AppErrorKind::Cancelled
        );
    }
}
