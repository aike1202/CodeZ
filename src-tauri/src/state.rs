use std::sync::Arc;

use crate::{
    chat_runtime::ChatRuntime, error::ErrorReporter, logging::LoggingGuard,
    mcp_runtime::McpRuntimeManager,
};
use codez_core::{AppPaths, AtomicPersistence};
use codez_mcp::{McpProjectConfigService, McpSecretService, McpUserConfigService};
use codez_platform::ResourceLocator;
use codez_platform::{NativeProcessRunner, PtyManager};
use codez_providers::service::ProviderService;
use codez_runtime::attachment::AttachmentService;
use codez_runtime::context::ledger::ModelLedgerStore;
use codez_runtime::edit_transaction::EditTransactionService;
use codez_runtime::fingerprint::ReadFingerprintStore;
use codez_runtime::history_revert::HistoryRevertService;
use codez_runtime::mutation_coordinator::FileMutationCoordinator;
use codez_runtime::permission::store::WorkspacePermissionStore;
use codez_runtime::session_deletion::SessionDeletionService;
use codez_runtime::session_maintenance::SessionMaintenanceCoordinator;
use codez_runtime::todo::TodoStore;
use codez_runtime::{CancellationTree, HostPreferences, ShutdownCoordinator, SystemService};
use codez_storage::{AtomicFileStore, OsCredentialStore, RecentProjectsStore};

#[allow(dead_code)]
pub(crate) struct AppState {
    pub(crate) system: Arc<SystemService>,
    pub(crate) host_preferences: Arc<HostPreferences>,
    pub(crate) resources: Arc<ResourceLocator>,
    pub(crate) storage: Arc<AtomicFileStore>,
    pub(crate) persistence: Arc<dyn AtomicPersistence>,
    pub(crate) recent_projects: Arc<RecentProjectsStore>,
    pub(crate) credentials: Arc<OsCredentialStore>,
    pub(crate) cancellation: Arc<CancellationTree>,
    pub(crate) session_maintenance: Arc<SessionMaintenanceCoordinator>,
    pub(crate) session_deletion: Arc<SessionDeletionService>,
    pub(crate) shutdown: Arc<ShutdownCoordinator>,
    pub(crate) errors: Arc<ErrorReporter>,
    pub(crate) attachment: Arc<AttachmentService>,
    pub(crate) fingerprint: Arc<ReadFingerprintStore>,
    pub(crate) mutation_coordinator: Arc<FileMutationCoordinator>,
    pub(crate) edit_transaction: Arc<EditTransactionService>,
    pub(crate) history_revert: Arc<HistoryRevertService>,
    pub(crate) _logging: LoggingGuard,
    pub(crate) paths: Arc<AppPaths>,
    pub(crate) process_runner: Arc<NativeProcessRunner>,
    pub(crate) pty_manager: Arc<PtyManager>,
    pub(crate) provider_service: Arc<ProviderService>,
    pub(crate) todo_store: Arc<TodoStore>,
    pub(crate) workspace_permissions: Arc<WorkspacePermissionStore>,
    pub(crate) mcp_config: Arc<McpUserConfigService>,
    pub(crate) mcp_project_config: Arc<McpProjectConfigService>,
    pub(crate) mcp_secrets: Arc<McpSecretService>,
    pub(crate) mcp_runtime: Arc<McpRuntimeManager>,
    pub(crate) model_ledger: Arc<ModelLedgerStore>,
    pub(crate) chat_runtime: Arc<ChatRuntime>,
}
