use std::{
    collections::HashMap,
    fs,
    panic::AssertUnwindSafe,
    path::{Path, PathBuf},
    sync::{
        Arc, RwLock, RwLockReadGuard, RwLockWriteGuard,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use codez_contracts::subagent::{
    SubAgentRunCancelResult, SubAgentRunRequest, SubAgentRunState, SubAgentRunStatus,
};
use codez_core::{
    AppError, AtomicPersistence, SessionId,
    provider::{ApiFormat, ChatMessage, ChatStreamEvent, Role},
    redact_sensitive_text,
};
use codez_providers::{
    chat::{
        ChatProvider, ChatProviderError, ChatRequestConfig, anthropic::AnthropicProvider,
        gemini::GeminiProvider, openai::OpenAiProvider,
    },
    service::{ProviderService, ResolvedProviderChatConfig},
};
use codez_runtime::{
    agent::{
        loop_impl::{
            AgentLoop, AgentLoopError, AgentLoopLimits, AgentStepContext, AgentStepExecutor,
            AgentStepOutcome,
        },
        state::AgentStatus,
        sub_agent::{
            SubAgentError, SubAgentId, SubAgentManager, SubAgentRegistration, SubAgentRole,
            SubAgentSnapshot, SubAgentStatus,
        },
    },
    session_maintenance::SessionActivityLease,
};
use futures_util::{FutureExt, StreamExt, stream::BoxStream};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::{fs as async_fs, sync::Mutex};

use crate::{error::ErrorReporter, subagent_boundary::SubAgentRunConfiguration};

const MAX_SUBAGENT_TASK_BYTES: usize = 128 * 1024;
const MAX_SUBAGENT_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_CONCURRENT_SUBAGENT_RUNS: usize = 8;
const PROVIDER_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const PERSISTENCE_VERSION: u8 = 1;
const STATE_EVENT: &str = "subagent:state";

/// Emits lifecycle-only updates. Task prompts, credentials, and Provider
/// diagnostics never cross this boundary.
pub(crate) trait SubAgentEventSink: Send + Sync {
    fn emit(&self, state: &SubAgentRunState);
}

/// Tauri event adapter for typed sub-agent lifecycle state.
pub(crate) struct TauriSubAgentEventSink {
    app: AppHandle,
    errors: Arc<ErrorReporter>,
}

impl TauriSubAgentEventSink {
    #[must_use]
    pub(crate) fn new(app: AppHandle, errors: Arc<ErrorReporter>) -> Self {
        Self { app, errors }
    }
}

impl SubAgentEventSink for TauriSubAgentEventSink {
    fn emit(&self, state: &SubAgentRunState) {
        if let Err(source) = self.app.emit(STATE_EVENT, state) {
            self.errors.log(&AppError::external(
                "Sub-agent state updates could not be delivered to the interface",
                format!("emit sub-agent state: {source}"),
                false,
            ));
        }
    }
}

#[derive(Debug, Clone)]
struct SubAgentCompletionRequest {
    provider_id: String,
    model: String,
    role: String,
    task: String,
}

#[async_trait]
trait SubAgentCompletion: Send + Sync {
    async fn complete(
        &self,
        request: SubAgentCompletionRequest,
        cancellation: codez_core::CancellationToken,
    ) -> Result<String, AppError>;
}

struct ProviderSubAgentCompletion {
    providers: Arc<ProviderService>,
}

#[async_trait]
impl SubAgentCompletion for ProviderSubAgentCompletion {
    async fn complete(
        &self,
        request: SubAgentCompletionRequest,
        cancellation: codez_core::CancellationToken,
    ) -> Result<String, AppError> {
        let resolved = self
            .providers
            .resolve_chat_config(Some(&request.provider_id), Some(&request.model))
            .await?;
        complete_with_provider(resolved, request, cancellation).await
    }
}

struct ProviderAgentStepExecutor {
    completion: Arc<dyn SubAgentCompletion>,
    request: SubAgentCompletionRequest,
    output: Arc<Mutex<Option<String>>>,
    cancellation: codez_core::CancellationToken,
}

#[async_trait]
impl AgentStepExecutor for ProviderAgentStepExecutor {
    async fn execute_step(&self, context: AgentStepContext) -> Result<AgentStepOutcome, AppError> {
        if self.cancellation.is_cancelled() {
            return Err(AppError::cancelled("The sub-agent run was interrupted"));
        }
        let completion = self
            .completion
            .complete(self.request.clone(), self.cancellation.child_token());
        tokio::pin!(completion);
        let output = tokio::select! {
            () = context.cancellation.cancelled() => {
                self.cancellation.cancel();
                return Err(AppError::cancelled("The sub-agent run was interrupted"));
            }
            () = self.cancellation.cancelled() => {
                return Err(AppError::cancelled("The sub-agent run was interrupted"));
            }
            output = &mut completion => output?,
        };
        *self.output.lock().await = Some(output);
        Ok(AgentStepOutcome::Complete)
    }
}

struct ActiveRun {
    id: SessionId,
    subagent_id: SubAgentId,
    subagent_type: String,
    session_id: String,
    provider_id: String,
    model: String,
    agent: Arc<AgentLoop>,
    output: Arc<Mutex<Option<String>>>,
    cancellation: codez_core::CancellationToken,
    events: Arc<dyn SubAgentEventSink>,
}

impl ActiveRun {
    async fn state(&self, manager: &SubAgentManager) -> Result<SubAgentRunState, AppError> {
        let snapshot = manager
            .snapshot(&self.subagent_id)
            .await
            .map_err(map_subagent_error)?;
        self.state_from_snapshot(snapshot).await
    }

    async fn state_from_snapshot(
        &self,
        snapshot: SubAgentSnapshot,
    ) -> Result<SubAgentRunState, AppError> {
        let status = map_status(snapshot.status)?;
        let agent = self.agent.snapshot().await;
        Ok(SubAgentRunState {
            run_id: self.id.as_str().to_string(),
            subagent_type: self.subagent_type.clone(),
            session_id: self.session_id.clone(),
            provider_id: self.provider_id.clone(),
            model: self.model.clone(),
            status,
            output: self.output.lock().await.clone(),
            error: agent.current_error,
            created_at: snapshot.created_at.to_rfc3339(),
            updated_at: snapshot.updated_at.to_rfc3339(),
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSubAgentRun {
    version: u8,
    state: SubAgentRunState,
}

/// Executes a bounded, tool-free delegated Provider request through the
/// existing agent loop and sub-agent lifecycle manager.
pub(crate) struct SubAgentRuntime {
    manager: SubAgentManager,
    completion: Arc<dyn SubAgentCompletion>,
    persistence: Arc<dyn AtomicPersistence>,
    storage_root: PathBuf,
    active: RwLock<HashMap<SessionId, Arc<ActiveRun>>>,
    admission: Mutex<()>,
    next_run: AtomicU64,
}

struct ActiveRunLifecycle {
    runtime: Arc<SubAgentRuntime>,
    run_id: SessionId,
    subagent_id: SubAgentId,
    activity: Option<SessionActivityLease>,
}

impl ActiveRunLifecycle {
    fn new(
        runtime: Arc<SubAgentRuntime>,
        run_id: SessionId,
        subagent_id: SubAgentId,
        activity: SessionActivityLease,
    ) -> Self {
        Self {
            runtime,
            run_id,
            subagent_id,
            activity: Some(activity),
        }
    }

    async fn execute_to_terminal(&self) -> Result<(), AppError> {
        self.runtime.execute_to_terminal(&self.run_id).await
    }
}

impl Drop for ActiveRunLifecycle {
    fn drop(&mut self) {
        self.runtime.active_runs_mut().remove(&self.run_id);
        if let Some(activity) = self.activity.take() {
            spawn_registration_cleanup(
                Arc::clone(&self.runtime),
                self.subagent_id.clone(),
                activity,
            );
        }
    }
}

struct SetupRegistrationGuard {
    runtime: Arc<SubAgentRuntime>,
    subagent_id: SubAgentId,
    activity: Option<SessionActivityLease>,
    registration_active: bool,
}

impl SetupRegistrationGuard {
    fn new(
        runtime: Arc<SubAgentRuntime>,
        subagent_id: SubAgentId,
        activity: SessionActivityLease,
    ) -> Self {
        Self {
            runtime,
            subagent_id,
            activity: Some(activity),
            registration_active: true,
        }
    }

    async fn release(&mut self) {
        match self
            .runtime
            .release_execution_registration(&self.subagent_id)
            .await
        {
            Ok(()) => self.registration_active = false,
            Err(error) => {
                tracing::error!(diagnostic = %error, "sub-agent setup registration could not be released");
            }
        }
    }

    fn into_activity(mut self) -> Result<SessionActivityLease, AppError> {
        let activity = self
            .activity
            .take()
            .ok_or_else(|| AppError::internal("sub-agent setup lost its session activity lease"))?;
        self.registration_active = false;
        Ok(activity)
    }
}

impl Drop for SetupRegistrationGuard {
    fn drop(&mut self) {
        if !self.registration_active {
            return;
        }
        if let Some(activity) = self.activity.take() {
            spawn_registration_cleanup(
                Arc::clone(&self.runtime),
                self.subagent_id.clone(),
                activity,
            );
        }
    }
}

fn spawn_registration_cleanup(
    runtime: Arc<SubAgentRuntime>,
    subagent_id: SubAgentId,
    activity: SessionActivityLease,
) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = runtime.release_execution_registration(&subagent_id).await {
            tracing::error!(diagnostic = %error, "sub-agent registration cleanup failed");
        }
        drop(activity);
    });
}

impl SubAgentRuntime {
    /// Builds the production Provider-backed sub-agent runtime.
    pub(crate) fn new(
        data_directory: &Path,
        persistence: Arc<dyn AtomicPersistence>,
        providers: Arc<ProviderService>,
    ) -> Result<Self, AppError> {
        Self::from_completion(
            data_directory,
            persistence,
            Arc::new(ProviderSubAgentCompletion { providers }),
        )
    }

    fn from_completion(
        data_directory: &Path,
        persistence: Arc<dyn AtomicPersistence>,
        completion: Arc<dyn SubAgentCompletion>,
    ) -> Result<Self, AppError> {
        let storage_root = data_directory.join("subagent-runs");
        fs::create_dir_all(&storage_root).map_err(|source| {
            AppError::storage(
                "Sub-agent state storage could not be initialized",
                format!("create {}: {source}", storage_root.display()),
                false,
            )
        })?;
        Ok(Self {
            manager: SubAgentManager::new(),
            completion,
            persistence,
            storage_root,
            active: RwLock::new(HashMap::new()),
            admission: Mutex::new(()),
            next_run: AtomicU64::new(0),
        })
    }

    /// Admits and starts one built-in sub-agent. The caller must resolve the
    /// enabled role and model candidate from persisted settings first.
    pub(crate) async fn start(
        self: &Arc<Self>,
        request: SubAgentRunRequest,
        configuration: SubAgentRunConfiguration,
        events: Arc<dyn SubAgentEventSink>,
        activity: SessionActivityLease,
    ) -> Result<SubAgentRunState, AppError> {
        validate_run_request(&request, &configuration.role)?;
        let session_id = SessionId::parse(request.session_id.clone())
            .map_err(|error| AppError::validation(error.to_string()))?;
        if activity.session_id() != &session_id {
            return Err(AppError::validation(
                "The sub-agent activity lease does not match the requested session",
            ));
        }
        let run_id = self.new_run_id()?;
        let subagent_id = SubAgentId::parse(run_id.as_str().to_string())
            .map_err(|_| AppError::internal("generated sub-agent ID was invalid"))?;
        let _admission = self.admission.lock().await;
        if self.active_runs().len() >= MAX_CONCURRENT_SUBAGENT_RUNS {
            return Err(AppError::conflict(
                "The maximum number of concurrent sub-agent runs has been reached",
            ));
        }

        let output = Arc::new(Mutex::new(None));
        let cancellation = codez_core::CancellationToken::new();
        let completion_request = SubAgentCompletionRequest {
            provider_id: configuration.selection.provider_id.clone(),
            model: configuration.selection.model.clone(),
            role: configuration.role.as_str().to_string(),
            task: request.task,
        };
        let executor = Arc::new(ProviderAgentStepExecutor {
            completion: Arc::clone(&self.completion),
            request: completion_request,
            output: Arc::clone(&output),
            cancellation: cancellation.clone(),
        });
        let limits = AgentLoopLimits::new(1)
            .map_err(|_| AppError::internal("sub-agent loop limits were invalid"))?;
        let agent = Arc::new(
            AgentLoop::with_limits(
                session_id.as_str().to_string(),
                run_id.as_str().to_string(),
                executor,
                limits,
            )
            .map_err(|error| AppError::validation(error.to_string()))?,
        );
        self.manager
            .register(SubAgentRegistration::new(
                subagent_id.clone(),
                configuration.role,
            ))
            .await
            .map_err(map_subagent_error)?;
        let mut setup =
            SetupRegistrationGuard::new(Arc::clone(self), subagent_id.clone(), activity);
        let running = match self
            .manager
            .transition(&subagent_id, SubAgentStatus::Running)
            .await
        {
            Ok(running) => running,
            Err(error) => {
                setup.release().await;
                return Err(map_subagent_error(error));
            }
        };
        let run = Arc::new(ActiveRun {
            id: run_id.clone(),
            subagent_id,
            subagent_type: request.subagent_type,
            session_id: session_id.as_str().to_string(),
            provider_id: configuration.selection.provider_id,
            model: configuration.selection.model,
            agent,
            output,
            cancellation,
            events,
        });
        let state = match run.state_from_snapshot(running).await {
            Ok(state) => state,
            Err(error) => {
                setup.release().await;
                return Err(error);
            }
        };
        if let Err(error) = emit_state(run.events.as_ref(), &state) {
            setup.release().await;
            return Err(error);
        }
        let activity = setup.into_activity()?;
        let lifecycle_subagent_id = run.subagent_id.clone();
        self.active_runs_mut().insert(run_id.clone(), run);
        let lifecycle =
            ActiveRunLifecycle::new(Arc::clone(self), run_id, lifecycle_subagent_id, activity);
        tauri::async_runtime::spawn(async move {
            if let Err(error) = lifecycle.execute_to_terminal().await {
                tracing::error!(diagnostic = %error, "sub-agent terminal lifecycle failed");
            }
        });
        Ok(state)
    }

    /// Returns current in-memory state, or a previously persisted terminal state.
    pub(crate) async fn status(
        &self,
        session_id: &SessionId,
        run_id: &str,
    ) -> Result<SubAgentRunState, AppError> {
        let run_id = parse_run_id(run_id)?;
        let active = self.active_runs().get(&run_id).cloned();
        match active {
            Some(run) if run.session_id == session_id.as_str() => {
                match run.state(&self.manager).await {
                    Ok(state) => Ok(state),
                    Err(active_error) => self
                        .read_terminal_state(session_id, &run_id)
                        .await
                        .or(Err(active_error)),
                }
            }
            Some(_) => Err(AppError::not_found("Sub-agent run was not found")),
            None => self.read_terminal_state(session_id, &run_id).await,
        }
    }

    /// Requests cancellation without discarding ownership before the Provider
    /// has observed the cancellation token and a terminal state is durable.
    pub(crate) async fn cancel(
        &self,
        session_id: &SessionId,
        run_id: &str,
    ) -> Result<SubAgentRunCancelResult, AppError> {
        let run_id = parse_run_id(run_id)?;
        let active = self.active_runs().get(&run_id).cloned();
        let Some(run) = active else {
            return Ok(SubAgentRunCancelResult {
                accepted: false,
                state: self.read_terminal_state(session_id, &run_id).await?,
            });
        };
        if run.session_id != session_id.as_str() {
            return Err(AppError::not_found("Sub-agent run was not found"));
        }
        let state = run.state(&self.manager).await?;
        let accepted = state.status == SubAgentRunStatus::Running;
        if accepted {
            run.cancellation.cancel();
            let _ = run.agent.stop().await;
        }
        Ok(SubAgentRunCancelResult { accepted, state })
    }

    /// Removes every persisted terminal run owned by one deleted session.
    ///
    /// Active runs are rejected defensively. Normal callers hold session maintenance, so no
    /// terminal writer can race the directory cleanup.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when a run is active or the session storage contains an unsafe entry
    /// or cannot be removed durably.
    pub(crate) async fn cleanup_session(&self, session_id: &SessionId) -> Result<(), AppError> {
        if self
            .active_runs()
            .values()
            .any(|run| run.session_id == session_id.as_str())
        {
            return Err(AppError::run_active(
                "Sub-agent runs are still active for the session",
            ));
        }

        validate_subagent_storage_directory(&self.storage_root, "sub-agent storage root").await?;
        let session_directory = self.session_storage_directory(session_id);
        match async_fs::symlink_metadata(&session_directory).await {
            Ok(metadata) => validate_subagent_directory_metadata(
                &session_directory,
                &metadata,
                "sub-agent session storage",
            )?,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(source) => {
                return Err(subagent_storage_error(
                    "inspect sub-agent session storage",
                    &session_directory,
                    source,
                ));
            }
        }

        let mut entries = async_fs::read_dir(&session_directory)
            .await
            .map_err(|source| {
                subagent_storage_error(
                    "enumerate sub-agent session storage",
                    &session_directory,
                    source,
                )
            })?;
        while let Some(entry) = entries.next_entry().await.map_err(|source| {
            subagent_storage_error(
                "read sub-agent session storage entry",
                &session_directory,
                source,
            )
        })? {
            let path = entry.path();
            let metadata = async_fs::symlink_metadata(&path).await.map_err(|source| {
                subagent_storage_error("inspect sub-agent state entry", &path, source)
            })?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || is_subagent_reparse_point(&metadata)
            {
                return Err(AppError::storage(
                    "Sub-agent state storage is unsafe",
                    format!("unsupported entry at {}", path.display()),
                    false,
                ));
            }
            self.persistence.remove(&path).await?;
        }
        drop(entries);

        match async_fs::remove_dir(&session_directory).await {
            Ok(()) => Ok(()),
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(subagent_storage_error(
                "remove empty sub-agent session storage",
                &session_directory,
                source,
            )),
        }
    }

    async fn execute_to_terminal(&self, run_id: &SessionId) -> Result<(), AppError> {
        let run = self
            .active_runs()
            .get(run_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("Sub-agent run was not found"))?;
        let operation = AssertUnwindSafe(self.complete_terminal_operation(run_id, &run))
            .catch_unwind()
            .await;
        let operation = match operation {
            Ok(result) => result,
            Err(_) => Err(AppError::internal("sub-agent terminal lifecycle panicked")),
        };
        if let Err(error) = &operation {
            if let Err(report_error) = self.report_terminal_failure(run_id, &run, error).await {
                tracing::error!(diagnostic = %report_error, "sub-agent terminal failure could not be reported");
            }
        }
        let cleanup = self.release_execution_registration(&run.subagent_id).await;
        match (operation, cleanup) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
            (Err(error), Err(cleanup_error)) => {
                tracing::error!(
                    diagnostic = %cleanup_error,
                    "sub-agent manager registration cleanup failed after a terminal error"
                );
                Err(error)
            }
        }
    }

    async fn complete_terminal_operation(
        &self,
        run_id: &SessionId,
        run: &ActiveRun,
    ) -> Result<(), AppError> {
        let execution = run.agent.run_step().await;
        let terminal_status = if run.cancellation.is_cancelled() {
            SubAgentStatus::Interrupted
        } else {
            match execution {
                Ok(AgentStatus::Completed) => SubAgentStatus::Completed,
                Ok(AgentStatus::Paused) => SubAgentStatus::Interrupted,
                Ok(AgentStatus::Idle | AgentStatus::Running | AgentStatus::Failed)
                | Err(AgentLoopError::Execution(_))
                | Err(AgentLoopError::StepLimitExceeded { .. })
                | Err(AgentLoopError::AttemptGenerationExhausted) => SubAgentStatus::Failed,
                Err(
                    AgentLoopError::InvalidIdentifier { .. }
                    | AgentLoopError::InvalidStepLimit
                    | AgentLoopError::InvalidState { .. },
                ) => SubAgentStatus::Failed,
            }
        };
        let snapshot = self
            .manager
            .transition(&run.subagent_id, terminal_status)
            .await
            .map_err(map_subagent_error)?;
        let state = run.state_from_snapshot(snapshot).await?;
        self.persist_terminal_state(run_id, &state).await?;
        emit_state(run.events.as_ref(), &state)?;
        Ok(())
    }

    async fn report_terminal_failure(
        &self,
        run_id: &SessionId,
        run: &ActiveRun,
        error: &AppError,
    ) -> Result<(), AppError> {
        let snapshot = self
            .manager
            .snapshot(&run.subagent_id)
            .await
            .map_err(map_subagent_error)?;
        let snapshot = if matches!(
            snapshot.status,
            SubAgentStatus::Completed | SubAgentStatus::Failed | SubAgentStatus::Interrupted
        ) {
            snapshot
        } else {
            self.manager
                .transition(&run.subagent_id, SubAgentStatus::Failed)
                .await
                .map_err(map_subagent_error)?
        };
        let mut state = run.state_from_snapshot(snapshot).await?;
        state.status = if run.cancellation.is_cancelled() {
            SubAgentRunStatus::Interrupted
        } else {
            SubAgentRunStatus::Failed
        };
        state.error = Some(error.public_message().to_string());

        let persistence = self.persist_terminal_state(run_id, &state).await;
        let emission = emit_state(run.events.as_ref(), &state);
        match (persistence, emission) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
            (Err(error), Err(emission_error)) => {
                tracing::error!(diagnostic = %emission_error, "sub-agent terminal failure event could not be delivered");
                Err(error)
            }
        }
    }

    async fn release_execution_registration(
        &self,
        subagent_id: &SubAgentId,
    ) -> Result<(), AppError> {
        let snapshot = match self.manager.snapshot(subagent_id).await {
            Ok(snapshot) => snapshot,
            Err(SubAgentError::NotFound { .. }) => return Ok(()),
            Err(error) => return Err(map_subagent_error(error)),
        };
        if !matches!(
            snapshot.status,
            SubAgentStatus::Completed | SubAgentStatus::Failed | SubAgentStatus::Interrupted
        ) {
            self.manager
                .transition(subagent_id, SubAgentStatus::Failed)
                .await
                .map_err(map_subagent_error)?;
        }
        match self.manager.remove_terminal(subagent_id).await {
            Ok(()) | Err(SubAgentError::NotFound { .. }) => Ok(()),
            Err(error) => Err(map_subagent_error(error)),
        }
    }

    fn active_runs(&self) -> RwLockReadGuard<'_, HashMap<SessionId, Arc<ActiveRun>>> {
        self.active
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn active_runs_mut(&self) -> RwLockWriteGuard<'_, HashMap<SessionId, Arc<ActiveRun>>> {
        self.active
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    async fn persist_terminal_state(
        &self,
        run_id: &SessionId,
        state: &SubAgentRunState,
    ) -> Result<(), AppError> {
        let session_id = SessionId::parse(state.session_id.clone())
            .map_err(|error| AppError::internal(format!("invalid terminal session ID: {error}")))?;
        prepare_subagent_session_storage(
            &self.storage_root,
            &self.session_storage_directory(&session_id),
        )
        .await?;
        let bytes = serde_json::to_vec(&PersistedSubAgentRun {
            version: PERSISTENCE_VERSION,
            state: state.clone(),
        })
        .map_err(|error| {
            AppError::internal(format!("serialize sub-agent terminal state: {error}"))
        })?;
        self.persistence
            .replace(&self.state_path(&session_id, run_id), &bytes)
            .await
    }

    async fn read_terminal_state(
        &self,
        session_id: &SessionId,
        run_id: &SessionId,
    ) -> Result<SubAgentRunState, AppError> {
        if !validate_subagent_session_storage_if_present(
            &self.storage_root,
            &self.session_storage_directory(session_id),
        )
        .await?
        {
            return Err(AppError::not_found("Sub-agent run was not found"));
        }
        let path = self.state_path(session_id, run_id);
        let Some(bytes) = self.persistence.read(&path).await? else {
            return Err(AppError::not_found("Sub-agent run was not found"));
        };
        let persisted =
            serde_json::from_slice::<PersistedSubAgentRun>(&bytes).map_err(|error| {
                AppError::storage(
                    "Stored sub-agent state is invalid",
                    format!("decode {}: {error}", path.display()),
                    false,
                )
            })?;
        if persisted.version != PERSISTENCE_VERSION {
            return Err(AppError::storage(
                "Stored sub-agent state uses an unsupported version",
                format!("version {}", persisted.version),
                false,
            ));
        }
        if persisted.state.session_id != session_id.as_str()
            || persisted.state.run_id != run_id.as_str()
        {
            return Err(AppError::storage(
                "Stored sub-agent state has an invalid identity",
                format!("identity mismatch at {}", path.display()),
                false,
            ));
        }
        Ok(persisted.state)
    }

    fn session_storage_directory(&self, session_id: &SessionId) -> PathBuf {
        self.storage_root.join(session_id.as_str())
    }

    fn state_path(&self, session_id: &SessionId, run_id: &SessionId) -> PathBuf {
        self.session_storage_directory(session_id)
            .join(format!("{}.json", run_id.as_str()))
    }

    fn new_run_id(&self) -> Result<SessionId, AppError> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| AppError::internal(format!("read sub-agent clock: {error}")))?
            .as_nanos();
        let sequence = self.next_run.fetch_add(1, Ordering::Relaxed);
        SessionId::parse(format!(
            "subagent-{timestamp}-{}-{sequence}",
            std::process::id()
        ))
        .map_err(|_| AppError::internal("generated sub-agent run ID was invalid"))
    }
}

async fn prepare_subagent_session_storage(
    storage_root: &Path,
    session_directory: &Path,
) -> Result<(), AppError> {
    validate_subagent_storage_directory(storage_root, "sub-agent storage root").await?;
    match async_fs::create_dir(session_directory).await {
        Ok(()) => {}
        Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(source) => {
            return Err(subagent_storage_error(
                "create sub-agent session storage",
                session_directory,
                source,
            ));
        }
    }
    validate_subagent_storage_directory(session_directory, "sub-agent session storage").await
}

async fn validate_subagent_session_storage_if_present(
    storage_root: &Path,
    session_directory: &Path,
) -> Result<bool, AppError> {
    validate_subagent_storage_directory(storage_root, "sub-agent storage root").await?;
    match async_fs::symlink_metadata(session_directory).await {
        Ok(metadata) => {
            validate_subagent_directory_metadata(
                session_directory,
                &metadata,
                "sub-agent session storage",
            )?;
            Ok(true)
        }
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(subagent_storage_error(
            "inspect sub-agent session storage",
            session_directory,
            source,
        )),
    }
}

async fn validate_subagent_storage_directory(
    path: &Path,
    label: &'static str,
) -> Result<(), AppError> {
    let metadata = async_fs::symlink_metadata(path)
        .await
        .map_err(|source| subagent_storage_error("inspect sub-agent storage", path, source))?;
    validate_subagent_directory_metadata(path, &metadata, label)
}

fn validate_subagent_directory_metadata(
    path: &Path,
    metadata: &fs::Metadata,
    label: &'static str,
) -> Result<(), AppError> {
    if metadata.is_dir()
        && !metadata.file_type().is_symlink()
        && !is_subagent_reparse_point(metadata)
    {
        return Ok(());
    }
    Err(AppError::storage(
        "Sub-agent state storage is unsafe",
        format!("{label} is not a stable directory at {}", path.display()),
        false,
    ))
}

#[cfg(windows)]
fn is_subagent_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_subagent_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn subagent_storage_error(
    operation: &'static str,
    path: &Path,
    source: impl std::fmt::Display,
) -> AppError {
    AppError::storage(
        "Sub-agent state storage could not be updated",
        format!("{operation} at {}: {source}", path.display()),
        true,
    )
}

async fn complete_with_provider(
    resolved: ResolvedProviderChatConfig,
    request: SubAgentCompletionRequest,
    cancellation: codez_core::CancellationToken,
) -> Result<String, AppError> {
    let operation = collect_provider_output(resolved, request, cancellation.clone());
    match tokio::time::timeout(PROVIDER_TIMEOUT, operation).await {
        Ok(result) => result,
        Err(_) => {
            cancellation.cancel();
            Err(AppError::timeout(
                "The sub-agent Provider request timed out",
            ))
        }
    }
}

async fn collect_provider_output(
    resolved: ResolvedProviderChatConfig,
    request: SubAgentCompletionRequest,
    cancellation: codez_core::CancellationToken,
) -> Result<String, AppError> {
    let messages = subagent_messages(&request);
    let mut stream = open_provider_stream(resolved, messages, cancellation.clone())
        .await
        .map_err(provider_error)?;
    let mut content = String::new();
    loop {
        tokio::select! {
            () = cancellation.cancelled() => {
                return Err(AppError::cancelled("The sub-agent run was interrupted"));
            }
            event = stream.next() => match event {
                Some(Ok(ChatStreamEvent::Chunk { delta, tool_calls, .. })) => {
                    if tool_calls.is_some_and(|calls| !calls.is_empty()) {
                        return Err(AppError::external(
                            "The sub-agent Provider attempted an unsupported tool call",
                            "tool calls are disabled for the initial sub-agent runtime",
                            false,
                        ));
                    }
                    append_output(&mut content, &delta)?;
                }
                Some(Ok(ChatStreamEvent::Done { full_content, .. })) => {
                    if cancellation.is_cancelled() {
                        return Err(AppError::cancelled("The sub-agent run was interrupted"));
                    }
                    let output = if full_content.is_empty() { content } else { full_content };
                    ensure_output_limit(&output)?;
                    return Ok(output);
                }
                Some(Ok(ChatStreamEvent::Usage(_))) => {}
                Some(Err(error)) => return Err(provider_error(error)),
                None => {
                    return Err(AppError::external(
                        "The sub-agent Provider stream ended without a terminal result",
                        "provider stream closed before a Done event",
                        true,
                    ));
                }
            }
        }
    }
}

fn subagent_messages(request: &SubAgentCompletionRequest) -> Vec<ChatMessage> {
    vec![
        ChatMessage {
            role: Role::System,
            content: Some(format!(
                "You are the CodeZ {} sub-agent. Complete the delegated task directly. This initial Rust runtime has no tools; do not claim to inspect files or run commands you cannot access. Return a concise, evidence-aware handoff.",
                request.role
            )),
            tool_calls: None,
            tool_call_id: None,
            name: None,
            images: Vec::new(),
        },
        ChatMessage {
            role: Role::User,
            content: Some(request.task.clone()),
            tool_calls: None,
            tool_call_id: None,
            name: None,
            images: Vec::new(),
        },
    ]
}

async fn open_provider_stream(
    resolved: ResolvedProviderChatConfig,
    messages: Vec<ChatMessage>,
    cancellation: codez_core::CancellationToken,
) -> Result<BoxStream<'static, Result<ChatStreamEvent, ChatProviderError>>, ChatProviderError> {
    let api_format = resolved.api_format;
    let config = ChatRequestConfig {
        base_url: resolved.base_url,
        api_key: resolved.api_key,
        model: resolved.model.name,
        api_format: Some(api_format_name(api_format).to_string()),
        messages,
        tools: None,
        thinking: Some(resolved.thinking),
        max_output_tokens: resolved
            .model
            .max_output_tokens
            .map_or(Some(MAX_SUBAGENT_OUTPUT_BYTES as u32), |value| {
                Some(value.min(MAX_SUBAGENT_OUTPUT_BYTES as u32))
            }),
        resolve_image: false,
    };
    match api_format {
        ApiFormat::Openai => {
            OpenAiProvider::new()
                .stream_chat(config, cancellation)
                .await
        }
        ApiFormat::Anthropic => {
            AnthropicProvider::new()
                .stream_chat(config, cancellation)
                .await
        }
        ApiFormat::Gemini => {
            GeminiProvider::new()
                .stream_chat(config, cancellation)
                .await
        }
    }
}

const fn api_format_name(format: ApiFormat) -> &'static str {
    match format {
        ApiFormat::Openai => "openai",
        ApiFormat::Anthropic => "anthropic",
        ApiFormat::Gemini => "gemini",
    }
}

fn append_output(content: &mut String, delta: &str) -> Result<(), AppError> {
    if content.len().saturating_add(delta.len()) > MAX_SUBAGENT_OUTPUT_BYTES {
        return Err(AppError::external(
            "The sub-agent Provider response exceeds the output safety limit",
            "streamed Provider output exceeded the configured byte ceiling",
            false,
        ));
    }
    content.push_str(delta);
    Ok(())
}

fn ensure_output_limit(output: &str) -> Result<(), AppError> {
    if output.len() > MAX_SUBAGENT_OUTPUT_BYTES {
        return Err(AppError::external(
            "The sub-agent Provider response exceeds the output safety limit",
            "terminal Provider output exceeded the configured byte ceiling",
            false,
        ));
    }
    Ok(())
}

fn provider_error(error: ChatProviderError) -> AppError {
    match error {
        ChatProviderError::Cancelled => AppError::cancelled("The sub-agent run was interrupted"),
        ChatProviderError::RateLimit(_) | ChatProviderError::Network(_) => AppError::external(
            "The sub-agent Provider request failed",
            redact_sensitive_text(&error.to_string()),
            true,
        ),
        _ => AppError::external(
            "The sub-agent Provider request failed",
            redact_sensitive_text(&error.to_string()),
            false,
        ),
    }
}

fn validate_run_request(request: &SubAgentRunRequest, role: &SubAgentRole) -> Result<(), AppError> {
    if request.subagent_type != role.as_str() {
        return Err(AppError::validation(
            "The sub-agent request does not match the resolved sub-agent role",
        ));
    }
    if request.session_id.trim().is_empty() {
        return Err(AppError::validation("A sub-agent session ID is required"));
    }
    if request.task.trim().is_empty() {
        return Err(AppError::validation("A sub-agent task is required"));
    }
    if request.task.len() > MAX_SUBAGENT_TASK_BYTES {
        return Err(AppError::validation(
            "The sub-agent task exceeds the safety limit",
        ));
    }
    Ok(())
}

fn parse_run_id(value: &str) -> Result<SessionId, AppError> {
    SessionId::parse(value.to_string()).map_err(|error| AppError::validation(error.to_string()))
}

fn map_status(status: SubAgentStatus) -> Result<SubAgentRunStatus, AppError> {
    match status {
        SubAgentStatus::Running => Ok(SubAgentRunStatus::Running),
        SubAgentStatus::Completed => Ok(SubAgentRunStatus::Completed),
        SubAgentStatus::Failed => Ok(SubAgentRunStatus::Failed),
        SubAgentStatus::Interrupted => Ok(SubAgentRunStatus::Interrupted),
        SubAgentStatus::Idle | SubAgentStatus::Paused => Err(AppError::internal(
            "sub-agent runtime exposed a non-executable lifecycle state",
        )),
    }
}

fn map_subagent_error(error: SubAgentError) -> AppError {
    match error {
        SubAgentError::NotFound { .. } => AppError::not_found("Sub-agent run was not found"),
        _ => AppError::internal(format!("sub-agent lifecycle error: {error}")),
    }
}

fn emit_state(events: &dyn SubAgentEventSink, state: &SubAgentRunState) -> Result<(), AppError> {
    std::panic::catch_unwind(AssertUnwindSafe(|| events.emit(state)))
        .map_err(|_| AppError::internal("sub-agent state event sink panicked"))
}

#[cfg(test)]
mod tests {
    use std::{
        path::Path,
        sync::{Arc, Mutex as StdMutex},
    };

    use async_trait::async_trait;
    use codez_contracts::subagent::{
        SubAgentModelSelection, SubAgentRunCancelResult, SubAgentRunRequest, SubAgentRunStatus,
    };
    use codez_core::{
        AppError, AppErrorKind, AtomicCreateOutcome, AtomicPersistence, CancellationToken,
        PortFuture, SessionId,
    };
    use codez_runtime::{
        agent::sub_agent::{SubAgentId, SubAgentRegistration, SubAgentRole},
        session_maintenance::{SessionActivityLease, SessionMaintenanceCoordinator},
    };
    use codez_storage::AtomicFileStore;
    use tokio::{sync::Notify, time::timeout};

    use crate::subagent_boundary::SubAgentRunConfiguration;

    use super::{
        SetupRegistrationGuard, SubAgentCompletion, SubAgentCompletionRequest, SubAgentEventSink,
        SubAgentRunState, SubAgentRuntime,
    };

    #[derive(Default)]
    struct RecordingEvents {
        states: StdMutex<Vec<SubAgentRunState>>,
    }

    impl RecordingEvents {
        fn states(&self) -> Vec<SubAgentRunState> {
            self.states
                .lock()
                .expect("test event lock must be valid")
                .clone()
        }
    }

    impl SubAgentEventSink for RecordingEvents {
        fn emit(&self, state: &SubAgentRunState) {
            self.states
                .lock()
                .expect("test event lock must be valid")
                .push(state.clone());
        }
    }

    struct PanickingEvents;

    impl SubAgentEventSink for PanickingEvents {
        fn emit(&self, _state: &SubAgentRunState) {
            panic!("injected event sink panic");
        }
    }

    #[derive(Default)]
    struct DeterministicCompletion {
        requests: StdMutex<Vec<SubAgentCompletionRequest>>,
    }

    #[async_trait]
    impl SubAgentCompletion for DeterministicCompletion {
        async fn complete(
            &self,
            request: SubAgentCompletionRequest,
            _cancellation: CancellationToken,
        ) -> Result<String, AppError> {
            self.requests
                .lock()
                .expect("test request lock must be valid")
                .push(request);
            Ok("deterministic provider handoff".to_string())
        }
    }

    struct WaitingCompletion {
        started: Arc<Notify>,
    }

    #[derive(Default)]
    struct FailingReplacePersistence {
        inner: AtomicFileStore,
    }

    impl AtomicPersistence for FailingReplacePersistence {
        fn read<'a>(&'a self, path: &'a Path) -> PortFuture<'a, Option<Vec<u8>>> {
            self.inner.read(path)
        }

        fn replace<'a>(&'a self, _path: &'a Path, _bytes: &'a [u8]) -> PortFuture<'a, ()> {
            Box::pin(async {
                Err(AppError::storage(
                    "Test sub-agent state could not be persisted",
                    "injected terminal persistence failure",
                    false,
                ))
            })
        }

        fn create_no_clobber<'a>(
            &'a self,
            path: &'a Path,
            bytes: &'a [u8],
        ) -> PortFuture<'a, AtomicCreateOutcome> {
            self.inner.create_no_clobber(path, bytes)
        }

        fn append<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
            self.inner.append(path, bytes)
        }

        fn remove<'a>(&'a self, path: &'a Path) -> PortFuture<'a, bool> {
            self.inner.remove(path)
        }
    }

    #[async_trait]
    impl SubAgentCompletion for WaitingCompletion {
        async fn complete(
            &self,
            _request: SubAgentCompletionRequest,
            cancellation: CancellationToken,
        ) -> Result<String, AppError> {
            self.started.notify_one();
            cancellation.cancelled().await;
            Err(AppError::cancelled("test cancellation"))
        }
    }

    fn request(task: &str) -> SubAgentRunRequest {
        SubAgentRunRequest {
            subagent_type: "Explore".to_string(),
            session_id: "session-1".to_string(),
            task: task.to_string(),
        }
    }

    fn configuration() -> SubAgentRunConfiguration {
        SubAgentRunConfiguration {
            role: SubAgentRole::parse("Explore").expect("test role must be valid"),
            selection: SubAgentModelSelection {
                provider_id: "provider-1".to_string(),
                model: "model-1".to_string(),
            },
        }
    }

    fn runtime(directory: &Path, completion: Arc<dyn SubAgentCompletion>) -> Arc<SubAgentRuntime> {
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        runtime_with_persistence(directory, persistence, completion)
    }

    fn runtime_with_persistence(
        directory: &Path,
        persistence: Arc<dyn AtomicPersistence>,
        completion: Arc<dyn SubAgentCompletion>,
    ) -> Arc<SubAgentRuntime> {
        Arc::new(
            SubAgentRuntime::from_completion(directory, persistence, completion)
                .expect("test runtime storage must initialize"),
        )
    }

    fn activity() -> SessionActivityLease {
        SessionMaintenanceCoordinator::new()
            .try_begin_activity(test_session_id())
            .expect("test activity must begin")
    }

    fn test_session_id() -> SessionId {
        SessionId::parse("session-1").expect("test session ID must parse")
    }

    async fn terminal_state(runtime: &SubAgentRuntime, run_id: &str) -> SubAgentRunState {
        timeout(std::time::Duration::from_secs(1), async {
            loop {
                let state = runtime
                    .status(&test_session_id(), run_id)
                    .await
                    .expect("test run state must resolve");
                let terminal_is_durable = super::parse_run_id(run_id)
                    .map(|run_id| runtime.state_path(&test_session_id(), &run_id).is_file())
                    .unwrap_or(false);
                let lifecycle_released = match super::parse_run_id(run_id) {
                    Ok(run_id) => !runtime.active_runs().contains_key(&run_id),
                    Err(_) => false,
                };
                if state.status != SubAgentRunStatus::Running
                    && terminal_is_durable
                    && lifecycle_released
                {
                    return state;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("test run must reach a terminal state")
    }

    #[tokio::test]
    async fn deterministic_completion_should_execute_through_the_agent_loop_and_persist_only_terminal_state()
     {
        let directory = tempfile::tempdir().expect("test directory must exist");
        let completion = Arc::new(DeterministicCompletion::default());
        let runtime = runtime(
            directory.path(),
            Arc::clone(&completion) as Arc<dyn SubAgentCompletion>,
        );
        let events = Arc::new(RecordingEvents::default());

        let started = runtime
            .start(
                request("do-not-persist-this-task"),
                configuration(),
                events.clone(),
                activity(),
            )
            .await
            .expect("valid test run must start");
        let terminal = terminal_state(runtime.as_ref(), &started.run_id).await;
        let bytes = std::fs::read(runtime.state_path(
            &test_session_id(),
            &super::parse_run_id(&started.run_id).expect("generated ID must parse"),
        ))
        .expect("terminal state must be written atomically");

        assert_eq!(
            terminal.output.as_deref(),
            Some("deterministic provider handoff")
        );
        assert_eq!(
            completion
                .requests
                .lock()
                .expect("test request lock must be valid")[0]
                .model,
            "model-1"
        );
        assert!(
            events
                .states()
                .iter()
                .any(|state| state.status == SubAgentRunStatus::Running)
        );
        assert!(
            events
                .states()
                .iter()
                .any(|state| state.status == SubAgentRunStatus::Completed)
        );
        assert!(!String::from_utf8_lossy(&bytes).contains("do-not-persist-this-task"));
    }

    #[tokio::test]
    async fn terminal_state_lookup_should_require_the_owning_session() {
        let directory = tempfile::tempdir().expect("test directory must exist");
        let runtime = runtime(
            directory.path(),
            Arc::new(DeterministicCompletion::default()),
        );
        let started = runtime
            .start(
                request("persist terminal ownership"),
                configuration(),
                Arc::new(RecordingEvents::default()),
                activity(),
            )
            .await
            .expect("valid test run must start");
        terminal_state(runtime.as_ref(), &started.run_id).await;
        let other_session = SessionId::parse("session-2").expect("other session ID must parse");

        let error = runtime
            .status(&other_session, &started.run_id)
            .await
            .expect_err("another session must not resolve the terminal run");

        assert_eq!(error.kind(), AppErrorKind::NotFound);
    }

    #[tokio::test]
    async fn cleanup_session_should_remove_persisted_terminal_runs() {
        let directory = tempfile::tempdir().expect("test directory must exist");
        let runtime = runtime(
            directory.path(),
            Arc::new(DeterministicCompletion::default()),
        );
        let started = runtime
            .start(
                request("remove terminal state"),
                configuration(),
                Arc::new(RecordingEvents::default()),
                activity(),
            )
            .await
            .expect("valid test run must start");
        terminal_state(runtime.as_ref(), &started.run_id).await;

        runtime
            .cleanup_session(&test_session_id())
            .await
            .expect("terminal session cleanup must succeed");
        let error = runtime
            .status(&test_session_id(), &started.run_id)
            .await
            .expect_err("cleaned terminal state must no longer resolve");

        assert_eq!(error.kind(), AppErrorKind::NotFound);
    }

    #[tokio::test]
    async fn cleanup_session_should_reject_an_active_run() {
        let directory = tempfile::tempdir().expect("test directory must exist");
        let started_notify = Arc::new(Notify::new());
        let runtime = runtime(
            directory.path(),
            Arc::new(WaitingCompletion {
                started: Arc::clone(&started_notify),
            }),
        );
        let notified = started_notify.notified();
        let started = runtime
            .start(
                request("retain active state"),
                configuration(),
                Arc::new(RecordingEvents::default()),
                activity(),
            )
            .await
            .expect("valid test run must start");
        notified.await;

        let error = runtime
            .cleanup_session(&test_session_id())
            .await
            .expect_err("active sub-agent work must block cleanup");
        runtime
            .cancel(&test_session_id(), &started.run_id)
            .await
            .expect("test run cancellation must succeed");
        terminal_state(runtime.as_ref(), &started.run_id).await;

        assert_eq!(error.kind(), AppErrorKind::RunActive);
    }

    #[tokio::test]
    async fn cancellation_should_interrupt_the_provider_step_and_persist_interrupted_state() {
        let directory = tempfile::tempdir().expect("test directory must exist");
        let started_notify = Arc::new(Notify::new());
        let runtime = runtime(
            directory.path(),
            Arc::new(WaitingCompletion {
                started: Arc::clone(&started_notify),
            }),
        );
        let events = Arc::new(RecordingEvents::default());
        let notified = started_notify.notified();

        let started = runtime
            .start(
                request("wait for cancellation"),
                configuration(),
                events.clone(),
                activity(),
            )
            .await
            .expect("valid test run must start");
        notified.await;
        let SubAgentRunCancelResult { accepted, .. } = runtime
            .cancel(&test_session_id(), &started.run_id)
            .await
            .expect("running test run must accept cancellation");
        let terminal = terminal_state(runtime.as_ref(), &started.run_id).await;

        assert!(accepted);
        assert_eq!(terminal.status, SubAgentRunStatus::Interrupted);
        assert!(
            events
                .states()
                .iter()
                .any(|state| state.status == SubAgentRunStatus::Interrupted)
        );
    }

    #[tokio::test]
    async fn immediate_cancellation_should_win_before_the_agent_step_is_scheduled() {
        let directory = tempfile::tempdir().expect("test directory must exist");
        let runtime = runtime(
            directory.path(),
            Arc::new(WaitingCompletion {
                started: Arc::new(Notify::new()),
            }),
        );
        let events = Arc::new(RecordingEvents::default());

        let started = runtime
            .start(
                request("cancel immediately"),
                configuration(),
                events,
                activity(),
            )
            .await
            .expect("valid test run must start");
        let cancelled = runtime
            .cancel(&test_session_id(), &started.run_id)
            .await
            .expect("newly admitted run must accept cancellation");
        let terminal = terminal_state(runtime.as_ref(), &started.run_id).await;

        assert!(cancelled.accepted && terminal.status == SubAgentRunStatus::Interrupted);
    }

    #[tokio::test]
    async fn terminal_persistence_failure_should_release_all_runtime_ownership() {
        let directory = tempfile::tempdir().expect("test directory must exist");
        let persistence: Arc<dyn AtomicPersistence> =
            Arc::new(FailingReplacePersistence::default());
        let runtime = runtime_with_persistence(
            directory.path(),
            persistence,
            Arc::new(DeterministicCompletion::default()),
        );
        let coordinator = SessionMaintenanceCoordinator::new();
        let session_id = SessionId::parse("session-1").expect("test session ID must parse");
        let activity = coordinator
            .try_begin_activity(session_id.clone())
            .expect("test activity must begin");
        let events = Arc::new(RecordingEvents::default());

        runtime
            .start(
                request("fail terminal persistence"),
                configuration(),
                events.clone(),
                activity,
            )
            .await
            .expect("valid test run must start");
        timeout(std::time::Duration::from_secs(1), async {
            loop {
                let ownership_released = runtime.active_runs().is_empty()
                    && runtime.manager.list().await.is_empty()
                    && coordinator
                        .try_begin_maintenance(session_id.clone())
                        .is_ok();
                if ownership_released {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("failed terminal persistence must release all ownership");

        assert!(
            events
                .states()
                .iter()
                .any(|state| state.status == SubAgentRunStatus::Failed)
        );
    }

    #[tokio::test]
    async fn dropped_setup_guard_should_release_manager_registration_before_activity() {
        let directory = tempfile::tempdir().expect("test directory must exist");
        let runtime = runtime(
            directory.path(),
            Arc::new(DeterministicCompletion::default()),
        );
        let coordinator = SessionMaintenanceCoordinator::new();
        let session_id = SessionId::parse("session-1").expect("test session ID must parse");
        let activity = coordinator
            .try_begin_activity(session_id.clone())
            .expect("test activity must begin");
        let subagent_id =
            SubAgentId::parse("setup-cancelled").expect("test sub-agent ID must parse");
        runtime
            .manager
            .register(SubAgentRegistration::new(
                subagent_id.clone(),
                SubAgentRole::parse("Explore").expect("test role must parse"),
            ))
            .await
            .expect("test registration must succeed");

        let guard = SetupRegistrationGuard::new(Arc::clone(&runtime), subagent_id, activity);
        drop(guard);

        timeout(std::time::Duration::from_secs(1), async {
            loop {
                if runtime.manager.list().await.is_empty()
                    && coordinator
                        .try_begin_maintenance(session_id.clone())
                        .is_ok()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("dropped setup ownership must be cleaned asynchronously");
    }

    #[tokio::test]
    async fn setup_event_panic_should_release_all_runtime_ownership() {
        let directory = tempfile::tempdir().expect("test directory must exist");
        let runtime = runtime(
            directory.path(),
            Arc::new(DeterministicCompletion::default()),
        );
        let coordinator = SessionMaintenanceCoordinator::new();
        let session_id = SessionId::parse("session-1").expect("test session ID must parse");
        let activity = coordinator
            .try_begin_activity(session_id.clone())
            .expect("test activity must begin");

        let error = runtime
            .start(
                request("panic while emitting running state"),
                configuration(),
                Arc::new(PanickingEvents),
                activity,
            )
            .await
            .expect_err("event sink panic must become a typed start error");

        assert!(
            error.public_message() == "An internal error occurred"
                && runtime.active_runs().is_empty()
                && runtime.manager.list().await.is_empty()
                && coordinator.try_begin_maintenance(session_id).is_ok()
        );
    }

    #[tokio::test]
    async fn status_should_reject_an_unsafe_persisted_run_identifier() {
        let directory = tempfile::tempdir().expect("test directory must exist");
        let runtime = runtime(
            directory.path(),
            Arc::new(DeterministicCompletion::default()),
        );

        let error = runtime
            .status(&test_session_id(), "../outside")
            .await
            .expect_err("path-like run IDs must not reach persistence");

        assert_eq!(
            error.public_message(),
            "identifier is not a filesystem-safe segment"
        );
    }
}
