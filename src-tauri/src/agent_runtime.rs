use std::{
    path::PathBuf,
    sync::{Arc, OnceLock, Weak},
};

use async_trait::async_trait;
use codez_core::{AppError, CancellationToken};
use codez_providers::service::ProviderService;
use codez_runtime::agent::collaboration::{
    AgentAttemptExecutor, AgentAttemptOutput, AgentAttemptRequest,
};
use codez_storage::AtomicFileStore;

use crate::{
    chat_runtime::ChatRuntime,
    subagent_boundary::{read_settings_from_store, resolve_run_configuration},
};

pub(crate) struct DesktopAgentAttemptExecutor {
    data_directory: PathBuf,
    storage: Arc<AtomicFileStore>,
    providers: Arc<ProviderService>,
    chat: OnceLock<Weak<ChatRuntime>>,
}

impl DesktopAgentAttemptExecutor {
    #[must_use]
    pub(crate) fn new(
        data_directory: PathBuf,
        storage: Arc<AtomicFileStore>,
        providers: Arc<ProviderService>,
    ) -> Self {
        Self {
            data_directory,
            storage,
            providers,
            chat: OnceLock::new(),
        }
    }

    pub(crate) fn bind_chat_runtime(&self, chat: &Arc<ChatRuntime>) -> Result<(), AppError> {
        self.chat
            .set(Arc::downgrade(chat))
            .map_err(|_| AppError::internal("Agent executor Chat runtime was bound more than once"))
    }

    fn chat_runtime(&self) -> Result<Arc<ChatRuntime>, AppError> {
        self.chat
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| AppError::internal("Agent executor Chat runtime is unavailable"))
    }
}

#[async_trait]
impl AgentAttemptExecutor for DesktopAgentAttemptExecutor {
    async fn execute(
        &self,
        request: AgentAttemptRequest,
        cancellation: CancellationToken,
    ) -> Result<AgentAttemptOutput, AppError> {
        let settings = read_settings_from_store(&self.storage, &self.data_directory).await?;
        let configuration = resolve_run_configuration(&request.agent.role, settings.settings())?;
        let resolved = self
            .providers
            .resolve_chat_config(
                Some(&configuration.selection.provider_id),
                Some(&configuration.selection.model),
            )
            .await?;
        self.chat_runtime()?
            .execute_agent_attempt(Arc::clone(&self.providers), request, resolved, cancellation)
            .await
    }
}
