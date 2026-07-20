use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::{DateTime, SecondsFormat, Utc};
use codez_core::agent::{
    AGENT_SCHEMA_VERSION, AgentAttempt, AgentBudget, AgentCompletionPolicy, AgentMessage,
    AgentNode, AgentPolicy, AgentProfile, AgentResult, AgentResultStatus, AgentState, AgentUsage,
    DelegatedTask, MessageKind, WorkspaceAssignment, WorkspaceMode,
};
use codez_core::{
    AgentAttemptId, AgentId, ArtifactId, CancellationToken, Clock, IdGenerator, MessageId,
    RootRunId, SessionId,
};
use thiserror::Error;
use tokio::sync::{Mutex as AsyncMutex, Notify};

use super::artifact_store::{AgentArtifactError, AgentArtifactStore};
use super::budget::{AgentBudgetManager, BudgetError};
use super::mailbox::{DurableMailbox, MailboxAck, MailboxError};
use super::scheduler::{AgentScheduler, ScheduledAgent};
use super::store::{
    AgentAttemptRegistration, AgentControlStore, AgentHandle, AgentRegistration, AgentRootSnapshot,
    AgentStoreError, AgentTransitionRequest,
};
use super::task_dag::{TaskDagError, TaskDagPlanner, TaskReadiness};
use super::workspace_broker::{PrepareWorkspaceRequest, WorkspaceBroker, WorkspaceBrokerError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentSupervisorConfig {
    pub max_depth: u16,
    pub max_direct_children: usize,
    pub max_root_agents: usize,
    pub max_spawn_per_call: usize,
}

impl Default for AgentSupervisorConfig {
    fn default() -> Self {
        Self {
            max_depth: 2,
            max_direct_children: 3,
            max_root_agents: 12,
            max_spawn_per_call: 3,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnAgentInput {
    pub root_session_id: Option<SessionId>,
    pub task: DelegatedTask,
    pub profile: AgentProfile,
    pub workspace: WorkspaceAssignment,
    pub policy: AgentPolicy,
    pub budget: AgentBudget,
    pub provider_id: String,
    pub model_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnAgentRequest {
    pub root_run_id: RootRunId,
    pub parent_agent_id: AgentId,
    pub parent_attempt_id: AgentAttemptId,
    pub tool_call_id: String,
    pub agents: Vec<SpawnAgentInput>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendAgentMessageInput {
    pub root_run_id: RootRunId,
    pub from: AgentId,
    pub to: AgentId,
    pub kind: MessageKind,
    pub summary: String,
    pub correlation_id: Option<String>,
    pub reply_to: Option<MessageId>,
    pub idempotency_key: Option<String>,
    pub artifact_refs: Vec<ArtifactId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitMode {
    Any,
    All,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WaitOutcome {
    pub cursor: u64,
    pub timed_out: bool,
    pub agents: Vec<AgentNode>,
}

enum TaskDagAction {
    Queue(AgentId),
    Block(AgentId, Vec<codez_core::TaskId>),
}

#[derive(Debug, Error)]
pub enum SupervisorError {
    #[error("spawn request must contain at least one agent")]
    EmptySpawn,
    #[error("spawn request exceeds the per-call limit of {0}")]
    SpawnBatchLimit(usize),
    #[error("parent agent does not belong to the selected root")]
    ParentRootMismatch,
    #[error("parent attempt is not the current attempt for this agent")]
    ParentAttemptMismatch,
    #[error("parent agent is not currently running")]
    ParentNotRunning,
    #[error("parent policy does not allow delegation")]
    DelegationDenied,
    #[error("maximum agent depth was reached")]
    DepthLimit,
    #[error("direct child limit was reached")]
    DirectChildLimit,
    #[error("root agent limit was reached")]
    RootAgentLimit,
    #[error("review Agents must submit an explicit review verdict")]
    ReviewVerdictRequired,
    #[error("only review Agents can submit a review verdict")]
    ReviewVerdictNotAllowed,
    #[error("an approved review verdict requires a completed result")]
    ApprovedReviewMustComplete,
    #[error("shared_readonly workspace cannot expose writes")]
    ReadonlyWorkspaceWrite,
    #[error("a writable workspace requires write authority and a non-empty write scope")]
    WritableWorkspaceNotIsolated,
    #[error("isolated worktree assignment requires a frozen baseline revision")]
    MissingWorktreeBaseline,
    #[error("explore and review profiles must use a read-only workspace")]
    ReadonlyProfileWrite,
    #[error("root Agent registration requires a root session identity")]
    MissingRootSession,
    #[error("root Agent session identity does not match the persisted root")]
    RootSessionMismatch,
    #[error("agent communication is not authorized by the parent-child ACL")]
    MessageAclDenied,
    #[error("message sender or recipient was not found in the selected root")]
    MessageAgentNotFound,
    #[error("wait request must contain at least one agent")]
    EmptyWait,
    #[error("wait request references an agent outside the selected root")]
    WaitAgentNotFound,
    #[error("agent identifiers generated by the runtime were invalid")]
    InvalidGeneratedIdentifier,
    #[error(transparent)]
    Store(#[from] AgentStoreError),
    #[error(transparent)]
    Mailbox(#[from] MailboxError),
    #[error("large Agent messages require the durable artifact store")]
    ArtifactStoreUnavailable,
    #[error(transparent)]
    Artifact(#[from] AgentArtifactError),
    #[error(transparent)]
    Budget(#[from] BudgetError),
    #[error(transparent)]
    TaskDag(#[from] TaskDagError),
    #[error("writable Agent workspaces are unavailable because Git isolation is not configured")]
    WorkspaceUnavailable,
    #[error(transparent)]
    Workspace(#[from] WorkspaceBrokerError),
}

pub struct AgentSupervisor {
    config: AgentSupervisorConfig,
    store: Arc<AgentControlStore>,
    mailbox: Arc<DurableMailbox>,
    scheduler: Arc<AgentScheduler>,
    budgets: Arc<AgentBudgetManager>,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn IdGenerator>,
    workspaces: Option<Arc<WorkspaceBroker>>,
    artifacts: Option<Arc<AgentArtifactStore>>,
    changed: Notify,
    active_attempts: Mutex<HashMap<AgentAttemptId, CancellationToken>>,
    followup_writer: AsyncMutex<()>,
    task_dag_writer: AsyncMutex<()>,
}

impl AgentSupervisor {
    #[must_use]
    pub fn new(
        config: AgentSupervisorConfig,
        store: Arc<AgentControlStore>,
        mailbox: Arc<DurableMailbox>,
        scheduler: Arc<AgentScheduler>,
        budgets: Arc<AgentBudgetManager>,
        clock: Arc<dyn Clock>,
        ids: Arc<dyn IdGenerator>,
    ) -> Self {
        Self {
            config,
            store,
            mailbox,
            scheduler,
            budgets,
            clock,
            ids,
            workspaces: None,
            artifacts: None,
            changed: Notify::new(),
            active_attempts: Mutex::new(HashMap::new()),
            followup_writer: AsyncMutex::new(()),
            task_dag_writer: AsyncMutex::new(()),
        }
    }

    #[must_use]
    pub fn with_workspace_broker(mut self, workspaces: Arc<WorkspaceBroker>) -> Self {
        self.workspaces = Some(workspaces);
        self
    }

    #[must_use]
    pub fn with_artifact_store(mut self, artifacts: Arc<AgentArtifactStore>) -> Self {
        self.artifacts = Some(artifacts);
        self
    }

    pub async fn register_root(
        &self,
        root_run_id: RootRunId,
        input: SpawnAgentInput,
    ) -> Result<AgentHandle, SupervisorError> {
        self.register_root_inner(root_run_id, input, true).await
    }

    async fn register_root_inner(
        &self,
        root_run_id: RootRunId,
        input: SpawnAgentInput,
        enqueue: bool,
    ) -> Result<AgentHandle, SupervisorError> {
        validate_root_workspace(&input)?;
        let root_session_id = input
            .root_session_id
            .clone()
            .ok_or(SupervisorError::MissingRootSession)?;
        let existing = self.store.load(&root_run_id).await?;
        if let Some(root) = existing.root_agent() {
            if root.root_session_id != root_session_id {
                return Err(SupervisorError::RootSessionMismatch);
            }
            let attempt = existing
                .current_attempt(&root.id)
                .ok_or(SupervisorError::ParentAttemptMismatch)?;
            return Ok(AgentHandle {
                agent_id: root.id.clone(),
                attempt_id: attempt.id.clone(),
                state: root.state,
                created: false,
            });
        }
        let now = self.now();
        let agent_id = self.next_agent_id()?;
        let attempt_id = self.next_attempt_id()?;
        self.budgets
            .initialize_root(root_run_id.clone(), input.budget);
        let reserved = self
            .budgets
            .reserve(&root_run_id, agent_id.clone(), input.budget)?;
        let registration = AgentRegistration {
            node: AgentNode {
                schema_version: AGENT_SCHEMA_VERSION,
                id: agent_id.clone(),
                root_run_id: root_run_id.clone(),
                root_session_id,
                parent_id: None,
                depth: 0,
                profile: input.profile,
                task: input.task,
                policy: input.policy,
                budget: reserved,
                workspace: input.workspace,
                state: AgentState::Queued,
                state_revision: 1,
                created_by_tool_call_id: None,
                created_at: now.clone(),
                updated_at: now.clone(),
            },
            attempt: new_attempt(
                attempt_id.clone(),
                agent_id.clone(),
                1,
                AgentState::Queued,
                1,
                &input.provider_id,
                &input.model_id,
            ),
        };
        let result = self
            .store
            .register_root(registration, self.next_event_id(), now)
            .await;
        let handle = match result {
            Ok(handle) => handle,
            Err(error) => {
                let _ = self.budgets.release(&agent_id);
                return Err(error.into());
            }
        };
        if !handle.created {
            let _ = self.budgets.release(&agent_id);
        }
        if handle.created && enqueue {
            self.scheduler.enqueue(ScheduledAgent {
                root_run_id,
                agent_id: handle.agent_id.clone(),
                attempt_id: handle.attempt_id.clone(),
                provider_id: input.provider_id,
            });
            self.changed.notify_waiters();
        }
        Ok(handle)
    }

    pub async fn start_root_attempt(
        &self,
        root_run_id: RootRunId,
        input: SpawnAgentInput,
    ) -> Result<AgentHandle, SupervisorError> {
        self.start_root_attempt_inner(root_run_id, input, true)
            .await
    }

    /// Creates a root attempt for an execution loop that is still driven by an external runtime.
    /// The attempt is persisted identically to scheduled work but is not inserted into the queue.
    pub async fn start_root_attempt_direct(
        &self,
        root_run_id: RootRunId,
        input: SpawnAgentInput,
    ) -> Result<AgentHandle, SupervisorError> {
        self.start_root_attempt_inner(root_run_id, input, false)
            .await
    }

    async fn start_root_attempt_inner(
        &self,
        root_run_id: RootRunId,
        input: SpawnAgentInput,
        enqueue: bool,
    ) -> Result<AgentHandle, SupervisorError> {
        validate_root_workspace(&input)?;
        let snapshot = self.store.load(&root_run_id).await?;
        let Some(root) = snapshot.root_agent() else {
            return self.register_root_inner(root_run_id, input, enqueue).await;
        };
        if input.root_session_id.as_ref() != Some(&root.root_session_id) {
            return Err(SupervisorError::RootSessionMismatch);
        }
        let current = snapshot
            .current_attempt(&root.id)
            .ok_or(SupervisorError::ParentAttemptMismatch)?;
        if !root.state.is_terminal() {
            return Ok(AgentHandle {
                agent_id: root.id.clone(),
                attempt_id: current.id.clone(),
                state: root.state,
                created: false,
            });
        }
        self.budgets
            .initialize_root(root_run_id.clone(), input.budget);
        let reserved = self
            .budgets
            .reserve(&root_run_id, root.id.clone(), input.budget)?;
        let state_revision = root
            .state_revision
            .checked_add(1)
            .ok_or(AgentStoreError::SequenceOverflow)?;
        let ordinal = current
            .ordinal
            .checked_add(1)
            .ok_or(AgentStoreError::SequenceOverflow)?;
        let attempt_id = self.next_attempt_id()?;
        let result = self
            .store
            .create_attempt(
                &root_run_id,
                AgentAttemptRegistration {
                    attempt: new_attempt(
                        attempt_id.clone(),
                        root.id.clone(),
                        ordinal,
                        AgentState::Queued,
                        state_revision,
                        &input.provider_id,
                        &input.model_id,
                    ),
                    idempotency_key: None,
                    task: input.task,
                    profile: input.profile,
                    policy: input.policy,
                    budget: reserved,
                    workspace: input.workspace,
                },
                self.next_event_id(),
                self.now(),
            )
            .await;
        let handle = match result {
            Ok(handle) => handle,
            Err(error) => {
                let _ = self.budgets.release(&root.id);
                return Err(error.into());
            }
        };
        if enqueue {
            self.scheduler.enqueue(ScheduledAgent {
                root_run_id,
                agent_id: root.id.clone(),
                attempt_id,
                provider_id: input.provider_id,
            });
        }
        self.changed.notify_waiters();
        Ok(handle)
    }

    pub async fn start_followup_attempt(
        &self,
        root_run_id: &RootRunId,
        agent_id: &AgentId,
        tool_call_id: &str,
        input: SpawnAgentInput,
    ) -> Result<AgentHandle, SupervisorError> {
        let _writer = self.followup_writer.lock().await;
        validate_workspace(&input)?;
        let snapshot = self.store.load(root_run_id).await?;
        if let Some(existing) = snapshot.followup_attempt(agent_id, tool_call_id) {
            return Ok(existing);
        }
        let node = snapshot
            .nodes
            .get(agent_id)
            .ok_or_else(|| AgentStoreError::AgentNotFound(agent_id.to_string()))?;
        if !node.state.is_terminal() {
            return Err(AgentStoreError::InvalidEvent(
                "a follow-up requires a terminal Agent".to_string(),
            )
            .into());
        }
        if node.workspace.mode == WorkspaceMode::IsolatedWorktree {
            return Err(SupervisorError::WorkspaceUnavailable);
        }
        let parent_id = node
            .parent_id
            .as_ref()
            .ok_or(SupervisorError::DelegationDenied)?;
        let parent = snapshot
            .nodes
            .get(parent_id)
            .ok_or(SupervisorError::ParentRootMismatch)?;
        if parent.state != AgentState::Running || !parent.policy.can_delegate {
            return Err(SupervisorError::ParentNotRunning);
        }
        let current = snapshot
            .current_attempt(agent_id)
            .ok_or(SupervisorError::ParentAttemptMismatch)?;
        let state_revision = node
            .state_revision
            .checked_add(1)
            .ok_or(AgentStoreError::SequenceOverflow)?;
        let ordinal = current
            .ordinal
            .checked_add(1)
            .ok_or(AgentStoreError::SequenceOverflow)?;
        let effective_policy = parent.policy.intersect(&input.policy);
        if input.workspace.mode != WorkspaceMode::SharedReadonly && !effective_policy.can_write {
            return Err(SupervisorError::DelegationDenied);
        }
        let reserved = self.budgets.reserve_child(
            &parent.id,
            agent_id.clone(),
            parent.budget.min(&input.budget),
        )?;
        let attempt_id = self.next_attempt_id()?;
        let provider_id = input.provider_id.clone();
        let result = self
            .store
            .create_attempt(
                root_run_id,
                AgentAttemptRegistration {
                    attempt: new_attempt(
                        attempt_id.clone(),
                        agent_id.clone(),
                        ordinal,
                        AgentState::Queued,
                        state_revision,
                        &input.provider_id,
                        &input.model_id,
                    ),
                    idempotency_key: Some(tool_call_id.to_string()),
                    task: input.task,
                    profile: input.profile,
                    policy: effective_policy,
                    budget: reserved,
                    workspace: input.workspace,
                },
                self.next_event_id(),
                self.now(),
            )
            .await;
        if let Err(error) = result {
            let _ = self.budgets.release(agent_id);
            return Err(error.into());
        }
        self.scheduler.enqueue(ScheduledAgent {
            root_run_id: root_run_id.clone(),
            agent_id: agent_id.clone(),
            attempt_id: attempt_id.clone(),
            provider_id,
        });
        self.changed.notify_waiters();
        Ok(AgentHandle {
            agent_id: agent_id.clone(),
            attempt_id,
            state: AgentState::Queued,
            created: true,
        })
    }

    pub async fn start_user_followup_attempt(
        &self,
        root_run_id: &RootRunId,
        agent_id: &AgentId,
        idempotency_key: &str,
        input: SpawnAgentInput,
    ) -> Result<AgentHandle, SupervisorError> {
        let _writer = self.followup_writer.lock().await;
        validate_workspace(&input)?;
        let snapshot = self.store.load(root_run_id).await?;
        if let Some(existing) = snapshot.followup_attempt(agent_id, idempotency_key) {
            return Ok(existing);
        }
        let node = snapshot
            .nodes
            .get(agent_id)
            .ok_or_else(|| AgentStoreError::AgentNotFound(agent_id.to_string()))?;
        if !node.state.is_terminal() {
            return Err(AgentStoreError::InvalidEvent(
                "a follow-up requires a terminal Agent".to_string(),
            )
            .into());
        }
        if node.workspace.mode == WorkspaceMode::IsolatedWorktree {
            return Err(SupervisorError::WorkspaceUnavailable);
        }
        let root = snapshot
            .root_agent()
            .ok_or(SupervisorError::ParentRootMismatch)?;
        let current = snapshot
            .current_attempt(agent_id)
            .ok_or(SupervisorError::ParentAttemptMismatch)?;
        let state_revision = node
            .state_revision
            .checked_add(1)
            .ok_or(AgentStoreError::SequenceOverflow)?;
        let ordinal = current
            .ordinal
            .checked_add(1)
            .ok_or(AgentStoreError::SequenceOverflow)?;
        let effective_policy = node.policy.intersect(&input.policy);
        self.budgets
            .initialize_root(root_run_id.clone(), root.budget);
        let reserved = self.budgets.reserve(
            root_run_id,
            agent_id.clone(),
            node.budget.min(&input.budget),
        )?;
        let attempt_id = self.next_attempt_id()?;
        let provider_id = input.provider_id.clone();
        let result = self
            .store
            .create_attempt(
                root_run_id,
                AgentAttemptRegistration {
                    attempt: new_attempt(
                        attempt_id.clone(),
                        agent_id.clone(),
                        ordinal,
                        AgentState::Queued,
                        state_revision,
                        &input.provider_id,
                        &input.model_id,
                    ),
                    idempotency_key: Some(idempotency_key.to_string()),
                    task: input.task,
                    profile: input.profile,
                    policy: effective_policy,
                    budget: reserved,
                    workspace: input.workspace,
                },
                self.next_event_id(),
                self.now(),
            )
            .await;
        if let Err(error) = result {
            let _ = self.budgets.release(agent_id);
            return Err(error.into());
        }
        self.scheduler.enqueue(ScheduledAgent {
            root_run_id: root_run_id.clone(),
            agent_id: agent_id.clone(),
            attempt_id: attempt_id.clone(),
            provider_id,
        });
        self.changed.notify_waiters();
        Ok(AgentHandle {
            agent_id: agent_id.clone(),
            attempt_id,
            state: AgentState::Queued,
            created: true,
        })
    }

    pub async fn spawn_agents(
        &self,
        request: SpawnAgentRequest,
    ) -> Result<Vec<AgentHandle>, SupervisorError> {
        self.spawn_agents_with_policy(request, AgentCompletionPolicy::CollectAll)
            .await
    }

    pub async fn spawn_agents_with_policy(
        &self,
        request: SpawnAgentRequest,
        completion_policy: AgentCompletionPolicy,
    ) -> Result<Vec<AgentHandle>, SupervisorError> {
        if request.agents.is_empty() {
            return Err(SupervisorError::EmptySpawn);
        }
        if request.agents.len() > self.config.max_spawn_per_call {
            return Err(SupervisorError::SpawnBatchLimit(
                self.config.max_spawn_per_call,
            ));
        }
        let snapshot = self.store.load(&request.root_run_id).await?;
        if let Some(existing) =
            snapshot.spawn_batch(&request.parent_attempt_id, &request.tool_call_id)
        {
            return Ok(existing);
        }
        let parent = snapshot
            .nodes
            .get(&request.parent_agent_id)
            .ok_or(SupervisorError::ParentRootMismatch)?;
        if parent.root_run_id != request.root_run_id {
            return Err(SupervisorError::ParentRootMismatch);
        }
        let parent_attempt = snapshot
            .current_attempt(&request.parent_agent_id)
            .ok_or(SupervisorError::ParentAttemptMismatch)?;
        if parent_attempt.id != request.parent_attempt_id {
            return Err(SupervisorError::ParentAttemptMismatch);
        }
        if parent.state != AgentState::Running {
            return Err(SupervisorError::ParentNotRunning);
        }
        if !parent.policy.can_delegate {
            return Err(SupervisorError::DelegationDenied);
        }
        let child_depth = parent
            .depth
            .checked_add(1)
            .ok_or(SupervisorError::DepthLimit)?;
        if child_depth > self.config.max_depth || child_depth > parent.policy.max_depth {
            return Err(SupervisorError::DepthLimit);
        }
        let direct_limit = self
            .config
            .max_direct_children
            .min(usize::from(parent.policy.max_direct_children));
        if snapshot.children_of(&parent.id).len() + request.agents.len() > direct_limit {
            return Err(SupervisorError::DirectChildLimit);
        }
        let root_limit = self
            .config
            .max_root_agents
            .min(usize::from(parent.policy.max_root_agents));
        if snapshot.nodes.len() + request.agents.len() > root_limit {
            return Err(SupervisorError::RootAgentLimit);
        }
        let new_tasks = request
            .agents
            .iter()
            .map(|input| input.task.clone())
            .collect::<Vec<_>>();
        TaskDagPlanner::validate(snapshot.nodes.values(), &new_tasks)?;
        let now = self.now();
        let mut registrations = Vec::with_capacity(request.agents.len());
        let mut queued_jobs = Vec::with_capacity(request.agents.len());
        let mut reserved_agent_ids = Vec::with_capacity(request.agents.len());
        let mut prepared_attempt_ids = Vec::new();
        for input in &request.agents {
            let agent_id = self.next_agent_id()?;
            let attempt_id = self.next_attempt_id()?;
            let effective_policy = parent.policy.intersect(&input.policy);
            if input.workspace.mode != WorkspaceMode::SharedReadonly && !effective_policy.can_write
            {
                self.release_reservations(&reserved_agent_ids);
                self.cleanup_workspace_attempts(&prepared_attempt_ids).await;
                return Err(SupervisorError::DelegationDenied);
            }
            let mut prepared_input = input.clone();
            if prepared_input.workspace.mode == WorkspaceMode::IsolatedWorktree
                && prepared_input.workspace.baseline_revision.is_none()
            {
                let Some(workspaces) = self.workspaces.as_ref() else {
                    self.release_reservations(&reserved_agent_ids);
                    self.cleanup_workspace_attempts(&prepared_attempt_ids).await;
                    return Err(SupervisorError::WorkspaceUnavailable);
                };
                let prepared = workspaces
                    .prepare_isolated_worktree(
                        PrepareWorkspaceRequest {
                            root_run_id: request.root_run_id.clone(),
                            agent_id: agent_id.clone(),
                            attempt_id: attempt_id.clone(),
                            task_id: prepared_input.task.task_id.clone(),
                            source_root: prepared_input.workspace.root.clone().into(),
                            read_scope: prepared_input.workspace.read_scope.clone(),
                            write_scope: prepared_input.workspace.write_scope.clone(),
                        },
                        CancellationToken::new(),
                    )
                    .await;
                match prepared {
                    Ok(prepared) => {
                        prepared_input.workspace = prepared.assignment;
                        prepared_attempt_ids.push(attempt_id.clone());
                    }
                    Err(error) => {
                        self.release_reservations(&reserved_agent_ids);
                        self.cleanup_workspace_attempts(&prepared_attempt_ids).await;
                        return Err(error.into());
                    }
                }
            }
            if let Err(error) = validate_workspace(&prepared_input) {
                self.release_reservations(&reserved_agent_ids);
                self.cleanup_workspace_attempts(&prepared_attempt_ids).await;
                return Err(error);
            }
            let reserved = match self.budgets.reserve_child(
                &parent.id,
                agent_id.clone(),
                parent.budget.min(&prepared_input.budget),
            ) {
                Ok(reserved) => reserved,
                Err(error) => {
                    self.release_reservations(&reserved_agent_ids);
                    self.cleanup_workspace_attempts(&prepared_attempt_ids).await;
                    return Err(error.into());
                }
            };
            reserved_agent_ids.push(agent_id.clone());
            let (initial_state, initial_revision) = if prepared_input.task.dependencies.is_empty() {
                (AgentState::Queued, 1)
            } else {
                (AgentState::Created, 0)
            };
            registrations.push(AgentRegistration {
                node: AgentNode {
                    schema_version: AGENT_SCHEMA_VERSION,
                    id: agent_id.clone(),
                    root_run_id: request.root_run_id.clone(),
                    root_session_id: parent.root_session_id.clone(),
                    parent_id: Some(parent.id.clone()),
                    depth: child_depth,
                    profile: prepared_input.profile,
                    task: prepared_input.task.clone(),
                    policy: effective_policy,
                    budget: reserved,
                    workspace: prepared_input.workspace.clone(),
                    state: initial_state,
                    state_revision: initial_revision,
                    created_by_tool_call_id: Some(request.tool_call_id.clone()),
                    created_at: now.clone(),
                    updated_at: now.clone(),
                },
                attempt: new_attempt(
                    attempt_id.clone(),
                    agent_id.clone(),
                    1,
                    initial_state,
                    initial_revision,
                    &prepared_input.provider_id,
                    &prepared_input.model_id,
                ),
            });
            if initial_state == AgentState::Queued {
                queued_jobs.push(ScheduledAgent {
                    root_run_id: request.root_run_id.clone(),
                    agent_id,
                    attempt_id,
                    provider_id: prepared_input.provider_id.clone(),
                });
            }
        }
        let result = self
            .store
            .register_agents_with_policy(
                &request.root_run_id,
                &request.parent_attempt_id,
                &request.tool_call_id,
                registrations,
                completion_policy,
                self.next_event_id(),
                now,
            )
            .await;
        let handles = match result {
            Ok(handles) => handles,
            Err(error) => {
                self.release_reservations(&reserved_agent_ids);
                self.cleanup_workspace_attempts(&prepared_attempt_ids).await;
                return Err(error.into());
            }
        };
        if handles.iter().all(|handle| !handle.created) {
            self.release_reservations(&reserved_agent_ids);
            self.cleanup_workspace_attempts(&prepared_attempt_ids).await;
            let snapshot = self.store.load(&request.root_run_id).await?;
            return Ok(handles
                .into_iter()
                .map(|mut handle| {
                    if let Some(node) = snapshot.nodes.get(&handle.agent_id) {
                        handle.state = node.state;
                    }
                    handle
                })
                .collect());
        }
        for job in queued_jobs {
            self.scheduler.enqueue(job);
        }
        self.advance_task_dag(&request.root_run_id).await?;
        self.changed.notify_waiters();
        let snapshot = self.store.load(&request.root_run_id).await?;
        Ok(handles
            .into_iter()
            .map(|mut handle| {
                if let Some(node) = snapshot.nodes.get(&handle.agent_id) {
                    handle.state = node.state;
                }
                handle
            })
            .collect())
    }

    pub async fn transition(
        &self,
        root_run_id: &RootRunId,
        agent_id: &AgentId,
        attempt_id: &AgentAttemptId,
        expected_revision: u64,
        next: AgentState,
    ) -> Result<AgentNode, SupervisorError> {
        let node = self
            .store
            .transition(AgentTransitionRequest {
                root_run_id: root_run_id.clone(),
                agent_id: agent_id.clone(),
                attempt_id: attempt_id.clone(),
                expected_revision,
                next,
                event_id: self.next_event_id(),
                occurred_at: self.now(),
            })
            .await?;
        self.changed.notify_waiters();
        Ok(node)
    }

    pub async fn submit_result(
        &self,
        root_run_id: &RootRunId,
        agent_id: &AgentId,
        attempt_id: &AgentAttemptId,
        result: AgentResult,
    ) -> Result<AgentResult, SupervisorError> {
        let validation_snapshot = self.store.load(root_run_id).await?;
        let validation_node = validation_snapshot
            .nodes
            .get(agent_id)
            .ok_or_else(|| AgentStoreError::AgentNotFound(agent_id.to_string()))?;
        match (validation_node.profile, result.review_verdict) {
            (AgentProfile::Review, None) => {
                return Err(SupervisorError::ReviewVerdictRequired);
            }
            (AgentProfile::Review, Some(codez_core::agent::AgentReviewVerdict::Approved))
                if result.status != AgentResultStatus::Completed =>
            {
                return Err(SupervisorError::ApprovedReviewMustComplete);
            }
            (AgentProfile::Review, Some(_)) | (_, None) => {}
            (_, Some(_)) => return Err(SupervisorError::ReviewVerdictNotAllowed),
        }
        let persisted = self
            .store
            .submit_result(
                root_run_id,
                agent_id,
                attempt_id,
                result,
                self.next_event_id(),
                self.now(),
            )
            .await?;
        let snapshot = self.store.load(root_run_id).await?;
        let node = snapshot
            .nodes
            .get(agent_id)
            .ok_or_else(|| AgentStoreError::AgentNotFound(agent_id.to_string()))?;
        let parent_id = node.parent_id.clone();
        if !node.state.is_terminal() {
            let terminal = match persisted.status {
                AgentResultStatus::Completed | AgentResultStatus::Partial => AgentState::Completed,
                AgentResultStatus::Blocked => AgentState::Blocked,
                AgentResultStatus::Failed => AgentState::Failed,
            };
            self.transition(
                root_run_id,
                agent_id,
                attempt_id,
                node.state_revision,
                terminal,
            )
            .await?;
            if self.budgets.release(agent_id).is_ok()
                && let Some(parent_id) = parent_id.as_ref()
            {
                let snapshot = self.store.load(root_run_id).await?;
                if snapshot
                    .nodes
                    .get(parent_id)
                    .is_some_and(|parent| parent.state.is_terminal())
                {
                    let _ = self.budgets.release(parent_id);
                }
            }
        }
        if matches!(
            persisted.status,
            AgentResultStatus::Blocked | AgentResultStatus::Failed
        ) {
            let snapshot = self.store.load(root_run_id).await?;
            for sibling_id in snapshot.fail_fast_siblings(agent_id) {
                self.cancel_subtree(root_run_id, &sibling_id).await?;
            }
        }
        if let Some(parent_id) = parent_id {
            self.mailbox
                .send(AgentMessage {
                    id: self.next_message_id()?,
                    root_run_id: root_run_id.clone(),
                    from: agent_id.clone(),
                    to: parent_id,
                    kind: MessageKind::Result,
                    correlation_id: Some(attempt_id.to_string()),
                    reply_to: None,
                    idempotency_key: Some(format!("result:{attempt_id}")),
                    sequence: 0,
                    summary: bounded_mailbox_summary(&persisted.summary),
                    artifact_refs: persisted.artifact_refs.clone(),
                    created_at: self.now(),
                })
                .await?;
        } else {
            let snapshot = self.store.load(root_run_id).await?;
            let unfinished_children = snapshot
                .children_of(agent_id)
                .into_iter()
                .filter(|child| !child.state.is_terminal())
                .map(|child| child.id.clone())
                .collect::<Vec<_>>();
            for child_id in unfinished_children {
                self.cancel_subtree(root_run_id, &child_id).await?;
            }
        }
        self.advance_task_dag(root_run_id).await?;
        Ok(persisted)
    }

    pub async fn interrupt_attempt(
        &self,
        root_run_id: &RootRunId,
        agent_id: &AgentId,
        attempt_id: &AgentAttemptId,
    ) -> Result<AgentNode, SupervisorError> {
        let snapshot = self.store.load(root_run_id).await?;
        let node = snapshot
            .nodes
            .get(agent_id)
            .ok_or_else(|| AgentStoreError::AgentNotFound(agent_id.to_string()))?;
        if node.state.is_terminal() {
            return Ok(node.clone());
        }
        let interrupted = self
            .transition(
                root_run_id,
                agent_id,
                attempt_id,
                node.state_revision,
                AgentState::Interrupted,
            )
            .await?;
        let _ = self.budgets.release(agent_id);
        self.advance_task_dag(root_run_id).await?;
        Ok(interrupted)
    }

    async fn advance_task_dag(&self, root_run_id: &RootRunId) -> Result<(), SupervisorError> {
        let _writer = self.task_dag_writer.lock().await;
        loop {
            let snapshot = self.store.load(root_run_id).await?;
            let mut candidates = snapshot
                .nodes
                .values()
                .filter(|node| node.state == AgentState::Created)
                .collect::<Vec<_>>();
            candidates.sort_by(|left, right| left.id.as_str().cmp(right.id.as_str()));
            let mut action = None;
            for node in candidates {
                match TaskDagPlanner::readiness(&node.task, snapshot.nodes.values())? {
                    TaskReadiness::Ready => {
                        action = Some(TaskDagAction::Queue(node.id.clone()));
                        break;
                    }
                    TaskReadiness::Blocked(dependencies) => {
                        action = Some(TaskDagAction::Block(node.id.clone(), dependencies));
                        break;
                    }
                    TaskReadiness::Waiting => {}
                }
            }
            let Some(action) = action else {
                break;
            };
            match action {
                TaskDagAction::Queue(agent_id) => {
                    let node = snapshot
                        .nodes
                        .get(&agent_id)
                        .ok_or_else(|| AgentStoreError::AgentNotFound(agent_id.to_string()))?;
                    let attempt = snapshot
                        .current_attempt(&agent_id)
                        .ok_or_else(|| AgentStoreError::AttemptNotFound(agent_id.to_string()))?;
                    self.send_dependency_context(&snapshot, node, attempt)
                        .await?;
                    self.transition(
                        root_run_id,
                        &agent_id,
                        &attempt.id,
                        node.state_revision,
                        AgentState::Queued,
                    )
                    .await?;
                    self.scheduler.enqueue(ScheduledAgent {
                        root_run_id: root_run_id.clone(),
                        agent_id,
                        attempt_id: attempt.id.clone(),
                        provider_id: attempt.provider_id.clone(),
                    });
                }
                TaskDagAction::Block(agent_id, dependencies) => {
                    self.block_dependency_task(&snapshot, &agent_id, &dependencies)
                        .await?;
                }
            }
        }
        self.changed.notify_waiters();
        Ok(())
    }

    async fn send_dependency_context(
        &self,
        snapshot: &AgentRootSnapshot,
        node: &AgentNode,
        attempt: &AgentAttempt,
    ) -> Result<(), SupervisorError> {
        let Some(parent_id) = node.parent_id.as_ref() else {
            return Ok(());
        };
        for dependency in &node.task.dependencies {
            let dependency_node = snapshot
                .nodes
                .values()
                .find(|candidate| candidate.task.task_id == *dependency)
                .ok_or_else(|| TaskDagError::MissingDependency {
                    task: node.task.task_id.to_string(),
                    dependency: dependency.to_string(),
                })?;
            let dependency_attempt = snapshot
                .current_attempt(&dependency_node.id)
                .ok_or_else(|| AgentStoreError::AttemptNotFound(dependency_node.id.to_string()))?;
            let result = snapshot
                .results
                .get(&dependency_attempt.id)
                .ok_or_else(|| {
                    AgentStoreError::InvalidEvent(format!(
                        "completed dependency {} has no structured result",
                        dependency
                    ))
                })?;
            self.mailbox
                .send(AgentMessage {
                    id: self.next_message_id()?,
                    root_run_id: node.root_run_id.clone(),
                    from: parent_id.clone(),
                    to: node.id.clone(),
                    kind: MessageKind::SystemNotice,
                    correlation_id: Some(dependency.to_string()),
                    reply_to: None,
                    idempotency_key: Some(format!("task-dependency:{}:{}", attempt.id, dependency)),
                    sequence: 0,
                    summary: bounded_mailbox_summary(&format!(
                        "Dependency {} completed: {}",
                        dependency, result.summary
                    )),
                    artifact_refs: result.artifact_refs.clone(),
                    created_at: self.now(),
                })
                .await?;
        }
        Ok(())
    }

    async fn block_dependency_task(
        &self,
        snapshot: &AgentRootSnapshot,
        agent_id: &AgentId,
        dependencies: &[codez_core::TaskId],
    ) -> Result<(), SupervisorError> {
        let node = snapshot
            .nodes
            .get(agent_id)
            .ok_or_else(|| AgentStoreError::AgentNotFound(agent_id.to_string()))?;
        let attempt = snapshot
            .current_attempt(agent_id)
            .ok_or_else(|| AgentStoreError::AttemptNotFound(agent_id.to_string()))?;
        let dependency_list = dependencies
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        let summary = format!(
            "Task {} was blocked because dependencies did not complete successfully: {}",
            node.task.task_id, dependency_list
        );
        let result = AgentResult {
            status: AgentResultStatus::Blocked,
            summary: summary.clone(),
            conclusion: None,
            changes: Vec::new(),
            validations: Vec::new(),
            findings: Vec::new(),
            blockers: vec![summary],
            unresolved: dependencies
                .iter()
                .map(|dependency| format!("Dependency {dependency} requires resolution"))
                .collect(),
            recommended_next_actions: vec![
                "Resolve or rerun the failed dependency before retrying this task".to_string(),
            ],
            confidence: None,
            review_verdict: None,
            artifact_refs: Vec::new(),
            usage: attempt.usage,
        };
        let persisted = self
            .store
            .submit_result(
                &node.root_run_id,
                &node.id,
                &attempt.id,
                result,
                self.next_event_id(),
                self.now(),
            )
            .await?;
        self.transition(
            &node.root_run_id,
            &node.id,
            &attempt.id,
            node.state_revision,
            AgentState::Blocked,
        )
        .await?;
        let _ = self.budgets.release(&node.id);
        if let Some(parent_id) = node.parent_id.as_ref() {
            self.mailbox
                .send(AgentMessage {
                    id: self.next_message_id()?,
                    root_run_id: node.root_run_id.clone(),
                    from: node.id.clone(),
                    to: parent_id.clone(),
                    kind: MessageKind::Result,
                    correlation_id: Some(attempt.id.to_string()),
                    reply_to: None,
                    idempotency_key: Some(format!("result:{}", attempt.id)),
                    sequence: 0,
                    summary: bounded_mailbox_summary(&persisted.summary),
                    artifact_refs: persisted.artifact_refs,
                    created_at: self.now(),
                })
                .await?;
        }
        Ok(())
    }

    pub async fn send_message(
        &self,
        input: SendAgentMessageInput,
    ) -> Result<AgentMessage, SupervisorError> {
        let snapshot = self.store.load(&input.root_run_id).await?;
        let sender = snapshot
            .nodes
            .get(&input.from)
            .ok_or(SupervisorError::MessageAgentNotFound)?;
        let recipient = snapshot
            .nodes
            .get(&input.to)
            .ok_or(SupervisorError::MessageAgentNotFound)?;
        let direct = sender.parent_id.as_ref() == Some(&input.to)
            || recipient.parent_id.as_ref() == Some(&input.from);
        if !direct {
            return Err(SupervisorError::MessageAclDenied);
        }
        let waiting_attempt = (recipient.state == AgentState::WaitingMessage)
            .then(|| snapshot.current_attempt(&recipient.id).cloned())
            .flatten();
        let root_run_id = input.root_run_id.clone();
        let recipient_id = recipient.id.clone();
        let recipient_revision = recipient.state_revision;
        let mut summary = input.summary;
        let mut artifact_refs = input.artifact_refs;
        if summary.len() > MAX_INLINE_MESSAGE_BYTES {
            let artifacts = self
                .artifacts
                .as_ref()
                .ok_or(SupervisorError::ArtifactStoreUnavailable)?;
            let attempt = snapshot
                .current_attempt(&sender.id)
                .ok_or(SupervisorError::ParentAttemptMismatch)?;
            let artifact = artifacts
                .persist_message(&root_run_id, &sender.id, &attempt.id, &summary, self.now())
                .await?;
            if !artifact_refs.contains(&artifact.artifact_id) {
                artifact_refs.push(artifact.artifact_id);
            }
            summary = format!(
                "Large Agent message stored as artifact ({} bytes).",
                artifact.size_bytes
            );
        }
        let message = self
            .mailbox
            .send(AgentMessage {
                id: self.next_message_id()?,
                root_run_id: input.root_run_id,
                from: input.from,
                to: input.to,
                kind: input.kind,
                correlation_id: input.correlation_id,
                reply_to: input.reply_to,
                idempotency_key: input.idempotency_key,
                sequence: 0,
                summary,
                artifact_refs,
                created_at: self.now(),
            })
            .await
            .map_err(SupervisorError::from)?;
        if let Some(attempt) = waiting_attempt {
            self.transition(
                &root_run_id,
                &recipient_id,
                &attempt.id,
                recipient_revision,
                AgentState::Queued,
            )
            .await?;
            self.scheduler.enqueue(ScheduledAgent {
                root_run_id,
                agent_id: recipient_id,
                attempt_id: attempt.id,
                provider_id: attempt.provider_id,
            });
        }
        self.changed.notify_waiters();
        Ok(message)
    }

    pub async fn wait_agents(
        &self,
        root_run_id: &RootRunId,
        agent_ids: &[AgentId],
        mode: WaitMode,
        after_cursor: u64,
        include_progress: bool,
        timeout: Duration,
    ) -> Result<WaitOutcome, SupervisorError> {
        if agent_ids.is_empty() {
            return Err(SupervisorError::EmptyWait);
        }
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if let Some(outcome) = self
                .wait_snapshot(root_run_id, agent_ids, mode, after_cursor, include_progress)
                .await?
            {
                return Ok(outcome);
            }
            let notified = self.changed.notified();
            if let Some(outcome) = self
                .wait_snapshot(root_run_id, agent_ids, mode, after_cursor, include_progress)
                .await?
            {
                return Ok(outcome);
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                let snapshot = self.store.load(root_run_id).await?;
                return Ok(WaitOutcome {
                    cursor: snapshot.through_sequence,
                    timed_out: true,
                    agents: selected_agents(&snapshot, agent_ids)?,
                });
            }
        }
    }

    pub async fn cancel_subtree(
        &self,
        root_run_id: &RootRunId,
        agent_id: &AgentId,
    ) -> Result<Vec<AgentHandle>, SupervisorError> {
        let snapshot = self.store.load(root_run_id).await?;
        if !snapshot.nodes.contains_key(agent_id) {
            return Err(AgentStoreError::AgentNotFound(agent_id.to_string()).into());
        }
        let mut queue = VecDeque::from([agent_id.clone()]);
        let mut subtree = Vec::new();
        while let Some(parent) = queue.pop_front() {
            subtree.push(parent.clone());
            queue.extend(
                snapshot
                    .children_of(&parent)
                    .into_iter()
                    .map(|child| child.id.clone()),
            );
        }
        subtree.reverse();
        let mut cancelled = Vec::new();
        for current_id in subtree {
            let node = snapshot
                .nodes
                .get(&current_id)
                .ok_or_else(|| AgentStoreError::AgentNotFound(current_id.to_string()))?;
            if node.state.is_terminal() {
                continue;
            }
            let attempt = snapshot
                .current_attempt(&current_id)
                .ok_or_else(|| AgentStoreError::AgentNotFound(current_id.to_string()))?;
            self.cancel_active_attempt(&attempt.id);
            self.transition(
                root_run_id,
                &current_id,
                &attempt.id,
                node.state_revision,
                AgentState::Cancelled,
            )
            .await?;
            if self.budgets.release(&current_id).is_ok()
                && let Some(parent_id) = node.parent_id.as_ref()
                && snapshot
                    .nodes
                    .get(parent_id)
                    .is_some_and(|parent| parent.state.is_terminal())
            {
                let _ = self.budgets.release(parent_id);
            }
            cancelled.push(AgentHandle {
                agent_id: current_id,
                attempt_id: attempt.id.clone(),
                state: AgentState::Cancelled,
                created: false,
            });
        }
        self.advance_task_dag(root_run_id).await?;
        Ok(cancelled)
    }

    pub fn register_active_attempt(
        &self,
        attempt_id: AgentAttemptId,
        cancellation: CancellationToken,
    ) {
        if let Some(previous) = self
            .active_attempts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(attempt_id, cancellation)
        {
            previous.cancel();
        }
    }

    pub fn unregister_active_attempt(&self, attempt_id: &AgentAttemptId) {
        self.active_attempts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(attempt_id);
    }

    fn cancel_active_attempt(&self, attempt_id: &AgentAttemptId) {
        if let Some(cancellation) = self
            .active_attempts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(attempt_id)
            .cloned()
        {
            cancellation.cancel();
        }
    }

    pub async fn mailbox_delta(
        &self,
        root_run_id: &RootRunId,
        agent_id: &AgentId,
        attempt_id: &AgentAttemptId,
        limit: usize,
    ) -> Result<Vec<AgentMessage>, SupervisorError> {
        let snapshot = self.store.load(root_run_id).await?;
        let attempt = snapshot
            .attempts
            .get(attempt_id)
            .ok_or_else(|| AgentStoreError::AttemptNotFound(attempt_id.to_string()))?;
        if attempt.agent_id != *agent_id {
            return Err(AgentStoreError::AttemptAgentMismatch.into());
        }
        self.mailbox
            .list_after(root_run_id, agent_id, attempt.mailbox_cursor, limit)
            .await
            .map_err(Into::into)
    }

    pub async fn consume_mailbox(
        &self,
        root_run_id: &RootRunId,
        attempt_id: &AgentAttemptId,
        messages: &[AgentMessage],
    ) -> Result<u64, SupervisorError> {
        let mut cursor = 0;
        for message in messages {
            self.mailbox
                .ack(
                    root_run_id,
                    MailboxAck {
                        message_id: message.id.clone(),
                        attempt_id: attempt_id.clone(),
                        acknowledged_at: self.now(),
                    },
                    self.next_event_id(),
                )
                .await?;
            cursor = cursor.max(message.sequence);
        }
        if cursor > 0 {
            self.store
                .advance_mailbox_cursor(
                    root_run_id,
                    attempt_id,
                    cursor,
                    self.next_event_id(),
                    self.now(),
                )
                .await?;
        }
        Ok(cursor)
    }

    pub async fn record_usage(
        &self,
        root_run_id: &RootRunId,
        agent_id: &AgentId,
        attempt_id: &AgentAttemptId,
        usage: AgentUsage,
    ) -> Result<AgentBudget, SupervisorError> {
        let remaining = self.budgets.record_usage(agent_id, usage)?;
        self.store
            .record_usage(
                root_run_id,
                attempt_id,
                usage,
                remaining,
                self.next_event_id(),
                self.now(),
            )
            .await?;
        Ok(remaining)
    }

    pub async fn recover_orphaned_attempts(&self) -> Result<Vec<AgentHandle>, SupervisorError> {
        let mut recovered = Vec::new();
        for root_run_id in self.store.discover_root_run_ids().await? {
            let snapshot = self.store.load(&root_run_id).await?;
            if let Some(root) = snapshot.root_agent() {
                let committed = snapshot
                    .attempts
                    .values()
                    .fold(AgentUsage::default(), |total, attempt| {
                        add_agent_usage(total, attempt.usage)
                    });
                self.budgets
                    .restore_root(root_run_id.clone(), root.budget, committed);
            }
            let mut agents = snapshot.nodes.values().collect::<Vec<_>>();
            agents.sort_by_key(|agent| std::cmp::Reverse(agent.depth));
            for node in agents {
                if node.state.is_terminal() {
                    continue;
                }
                let attempt = snapshot
                    .current_attempt(&node.id)
                    .ok_or(SupervisorError::ParentAttemptMismatch)?;
                let interrupted = self
                    .transition(
                        &root_run_id,
                        &node.id,
                        &attempt.id,
                        node.state_revision,
                        AgentState::Interrupted,
                    )
                    .await?;
                recovered.push(AgentHandle {
                    agent_id: node.id.clone(),
                    attempt_id: attempt.id.clone(),
                    state: interrupted.state,
                    created: false,
                });
            }
        }
        Ok(recovered)
    }

    #[must_use]
    pub fn store(&self) -> &Arc<AgentControlStore> {
        &self.store
    }

    #[must_use]
    pub fn mailbox(&self) -> &Arc<DurableMailbox> {
        &self.mailbox
    }

    #[must_use]
    pub fn scheduler(&self) -> &Arc<AgentScheduler> {
        &self.scheduler
    }

    async fn wait_snapshot(
        &self,
        root_run_id: &RootRunId,
        agent_ids: &[AgentId],
        mode: WaitMode,
        after_cursor: u64,
        include_progress: bool,
    ) -> Result<Option<WaitOutcome>, SupervisorError> {
        let snapshot = self.store.load(root_run_id).await?;
        let agents = selected_agents(&snapshot, agent_ids)?;
        let condition = match mode {
            WaitMode::Any => agents.iter().any(|agent| agent.state.is_terminal()),
            WaitMode::All => agents.iter().all(|agent| agent.state.is_terminal()),
        };
        if condition || (include_progress && snapshot.through_sequence > after_cursor) {
            Ok(Some(WaitOutcome {
                cursor: snapshot.through_sequence,
                timed_out: false,
                agents,
            }))
        } else {
            Ok(None)
        }
    }

    fn release_reservations(&self, agent_ids: &[AgentId]) {
        for agent_id in agent_ids.iter().rev() {
            let _ = self.budgets.release(agent_id);
        }
    }

    async fn cleanup_workspace_attempts(&self, attempt_ids: &[AgentAttemptId]) {
        let Some(workspaces) = self.workspaces.as_ref() else {
            return;
        };
        for attempt_id in attempt_ids {
            if let Err(error) = workspaces
                .cleanup(attempt_id, CancellationToken::new())
                .await
            {
                tracing::warn!(
                    attempt_id = %attempt_id,
                    diagnostic = %error,
                    "failed to clean an unregistered Agent worktree"
                );
            }
        }
    }

    fn next_agent_id(&self) -> Result<AgentId, SupervisorError> {
        AgentId::parse(format!("agent_{}", self.ids.next_id()))
            .map_err(|_| SupervisorError::InvalidGeneratedIdentifier)
    }

    fn next_attempt_id(&self) -> Result<AgentAttemptId, SupervisorError> {
        AgentAttemptId::parse(format!("attempt_{}", self.ids.next_id()))
            .map_err(|_| SupervisorError::InvalidGeneratedIdentifier)
    }

    fn next_message_id(&self) -> Result<MessageId, SupervisorError> {
        MessageId::parse(format!("message_{}", self.ids.next_id()))
            .map_err(|_| SupervisorError::InvalidGeneratedIdentifier)
    }

    fn next_event_id(&self) -> String {
        format!("event_{}", self.ids.next_id())
    }

    fn now(&self) -> String {
        DateTime::<Utc>::from(self.clock.now()).to_rfc3339_opts(SecondsFormat::Millis, true)
    }
}

const fn add_agent_usage(left: AgentUsage, right: AgentUsage) -> AgentUsage {
    AgentUsage {
        input_tokens: left.input_tokens.saturating_add(right.input_tokens),
        output_tokens: left.output_tokens.saturating_add(right.output_tokens),
        provider_cost_micros: left
            .provider_cost_micros
            .saturating_add(right.provider_cost_micros),
        tool_calls: left.tool_calls.saturating_add(right.tool_calls),
        model_visible_tool_result_bytes: left
            .model_visible_tool_result_bytes
            .saturating_add(right.model_visible_tool_result_bytes),
        command_wall_time_ms: left
            .command_wall_time_ms
            .saturating_add(right.command_wall_time_ms),
        wall_time_ms: left.wall_time_ms.saturating_add(right.wall_time_ms),
        files_read: left.files_read.saturating_add(right.files_read),
        files_written: left.files_written.saturating_add(right.files_written),
        child_agents: left.child_agents.saturating_add(right.child_agents),
    }
}

fn new_attempt(
    id: AgentAttemptId,
    agent_id: AgentId,
    ordinal: u32,
    state: AgentState,
    state_revision: u64,
    provider_id: &str,
    model_id: &str,
) -> AgentAttempt {
    AgentAttempt {
        id,
        agent_id,
        ordinal,
        state,
        state_revision,
        mailbox_cursor: 0,
        prompt_schema_version: AGENT_SCHEMA_VERSION,
        prompt_module_hashes: Vec::new(),
        dynamic_snapshot_hash: String::new(),
        tool_catalog_fingerprint: String::new(),
        provider_id: provider_id.to_string(),
        model_id: model_id.to_string(),
        result_contract_version: AGENT_SCHEMA_VERSION,
        usage: AgentUsage::default(),
        started_at: None,
        finished_at: None,
    }
}

fn validate_workspace(input: &SpawnAgentInput) -> Result<(), SupervisorError> {
    if matches!(input.profile, AgentProfile::Explore | AgentProfile::Review)
        && (input.policy.can_write
            || input.workspace.mode != WorkspaceMode::SharedReadonly
            || !input.workspace.write_scope.is_empty())
    {
        return Err(SupervisorError::ReadonlyProfileWrite);
    }
    match input.workspace.mode {
        WorkspaceMode::RootWorkspace => {
            if !input.policy.can_write || input.workspace.write_scope.is_empty() {
                return Err(SupervisorError::WritableWorkspaceNotIsolated);
            }
        }
        WorkspaceMode::SharedReadonly => {
            if input.policy.can_write || !input.workspace.write_scope.is_empty() {
                return Err(SupervisorError::ReadonlyWorkspaceWrite);
            }
        }
        WorkspaceMode::IsolatedWorktree => {
            if !input.policy.can_write || input.workspace.write_scope.is_empty() {
                return Err(SupervisorError::WritableWorkspaceNotIsolated);
            }
            if input.workspace.baseline_revision.is_none() {
                return Err(SupervisorError::MissingWorktreeBaseline);
            }
        }
        WorkspaceMode::IsolatedSnapshotPatch => {
            if !input.policy.can_write || input.workspace.write_scope.is_empty() {
                return Err(SupervisorError::WritableWorkspaceNotIsolated);
            }
        }
    }
    Ok(())
}

fn validate_root_workspace(input: &SpawnAgentInput) -> Result<(), SupervisorError> {
    if input.workspace.mode == WorkspaceMode::RootWorkspace {
        if !input.policy.can_write || input.workspace.write_scope.is_empty() {
            return Err(SupervisorError::WritableWorkspaceNotIsolated);
        }
        return Ok(());
    }
    validate_workspace(input)
}

fn selected_agents(
    snapshot: &AgentRootSnapshot,
    agent_ids: &[AgentId],
) -> Result<Vec<AgentNode>, SupervisorError> {
    let unique = agent_ids.iter().collect::<HashSet<_>>();
    if unique.len() != agent_ids.len() {
        return Err(SupervisorError::WaitAgentNotFound);
    }
    agent_ids
        .iter()
        .map(|agent_id| {
            snapshot
                .nodes
                .get(agent_id)
                .cloned()
                .ok_or(SupervisorError::WaitAgentNotFound)
        })
        .collect()
}

fn bounded_mailbox_summary(value: &str) -> String {
    if value.len() <= MAX_INLINE_MESSAGE_BYTES {
        return value.to_string();
    }
    let mut boundary = MAX_INLINE_MESSAGE_BYTES;
    while !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value[..boundary].to_string()
}

const MAX_INLINE_MESSAGE_BYTES: usize = 2 * 1024;
