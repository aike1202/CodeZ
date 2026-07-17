use std::{
    path::PathBuf,
    sync::{Arc, OnceLock, Weak},
};

use async_trait::async_trait;
use codez_contracts::subagent::SubAgentModelSelection;
use codez_core::context::MAIN_CONTEXT_SCOPE;
use codez_core::{AppError, CancellationToken};
use codez_providers::service::ProviderService;
use codez_runtime::agent::collaboration::{
    AgentAttemptExecutor, AgentAttemptOutput, AgentAttemptRequest,
};
use codez_runtime::context::ledger::ModelLedgerStore;
use codez_storage::AtomicFileStore;

use crate::{
    chat_runtime::ChatRuntime,
    subagent_boundary::{
        default_model_selection, has_configured_run_model, read_settings_from_store,
        resolve_run_configuration,
    },
};

pub(crate) struct DesktopAgentAttemptExecutor {
    data_directory: PathBuf,
    storage: Arc<AtomicFileStore>,
    providers: Arc<ProviderService>,
    ledger: Arc<ModelLedgerStore>,
    chat: OnceLock<Weak<ChatRuntime>>,
}

impl DesktopAgentAttemptExecutor {
    #[must_use]
    pub(crate) fn new(
        data_directory: PathBuf,
        storage: Arc<AtomicFileStore>,
        providers: Arc<ProviderService>,
        ledger: Arc<ModelLedgerStore>,
    ) -> Self {
        Self {
            data_directory,
            storage,
            providers,
            ledger,
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

    async fn parent_model_selection(
        &self,
        request: &AgentAttemptRequest,
    ) -> Result<Option<SubAgentModelSelection>, AppError> {
        let Some(snapshot) = self.ledger.get_snapshot(&request.session_id).await? else {
            return Ok(None);
        };
        let scope_key = if request.agent.parent_agent_id == "/root" {
            MAIN_CONTEXT_SCOPE.to_string()
        } else {
            format!("subagent:{}", request.agent.parent_agent_id)
        };
        let Some(scope) = snapshot.scopes.get(&scope_key) else {
            return Ok(None);
        };
        Ok(scope
            .last_provider_id
            .as_ref()
            .zip(scope.last_model.as_ref())
            .map(|(provider_id, model)| SubAgentModelSelection {
                provider_id: provider_id.clone(),
                model: model.clone(),
            }))
    }

    async fn fallback_model_selection(
        &self,
        request: &AgentAttemptRequest,
    ) -> Result<SubAgentModelSelection, AppError> {
        if let Some(selection) = self.parent_model_selection(request).await? {
            return Ok(selection);
        }
        default_model_selection(&self.providers).await
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
        let default_selection =
            if has_configured_run_model(&request.agent.role, settings.settings())? {
                None
            } else {
                Some(self.fallback_model_selection(&request).await?)
            };
        let configuration =
            resolve_run_configuration(&request.agent.role, settings.settings(), default_selection)?;
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
