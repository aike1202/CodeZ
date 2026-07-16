use std::sync::Arc;

use codez_core::{AppPaths, AtomicPersistence};
use codez_mcp::{McpSecretService, McpUserConfigService};
use codez_platform::ResourceLocator;
use codez_platform::{NativeProcessRunner, PtyManager};
use codez_providers::service::ProviderService;
use codez_runtime::attachment::AttachmentService;
use codez_runtime::context::ledger::ModelLedgerStore;
use codez_runtime::edit_transaction::EditTransactionService;
use codez_runtime::fingerprint::ReadFingerprintStore;
use codez_runtime::mutation_coordinator::FileMutationCoordinator;
use codez_runtime::permission::store::WorkspacePermissionStore;
use codez_runtime::{CancellationTree, HostPreferences, ShutdownCoordinator, SystemService};
use codez_storage::{
    AtomicFileStore, CredentialMigrationReport, CredentialReentry, ElectronSafeStorageReader,
    LegacyMigrationCoordinator, MigrationError, OsCredentialStore, RecentProjectsStore,
    StartupMigrationOutcome,
};
use tokio::sync::Mutex;

use crate::{
    chat_runtime::ChatRuntime, error::ErrorReporter, logging::LoggingGuard,
    mcp_runtime::McpRuntimeManager,
};

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
    pub(crate) shutdown: Arc<ShutdownCoordinator>,
    pub(crate) errors: Arc<ErrorReporter>,
    pub(crate) attachment: Arc<AttachmentService>,
    pub(crate) fingerprint: Arc<ReadFingerprintStore>,
    pub(crate) mutation_coordinator: Arc<FileMutationCoordinator>,
    pub(crate) edit_transaction: Arc<EditTransactionService>,
    pub(crate) _logging: LoggingGuard,
    pub(crate) paths: Arc<AppPaths>,
    pub(crate) process_runner: Arc<NativeProcessRunner>,
    pub(crate) pty_manager: Arc<PtyManager>,
    pub(crate) provider_service: Arc<ProviderService>,
    pub(crate) workspace_permissions: Arc<WorkspacePermissionStore>,
    pub(crate) mcp_config: Arc<McpUserConfigService>,
    pub(crate) mcp_secrets: Arc<McpSecretService>,
    pub(crate) mcp_runtime: Arc<McpRuntimeManager>,
    pub(crate) model_ledger: Arc<ModelLedgerStore>,
    pub(crate) chat_runtime: Arc<ChatRuntime>,
}

/// The only desktop state available while legacy credential migration is blocked.
///
/// Keeping this state separate from [`AppState`] means normal workspace, chat,
/// provider, and storage commands cannot resolve their Tauri state until a
/// verified migration activation has completed and the process restarts.
pub(crate) struct MigrationRecoveryState {
    pub(crate) errors: Arc<ErrorReporter>,
    coordinator: Arc<LegacyMigrationCoordinator<ElectronSafeStorageReader, OsCredentialStore>>,
    snapshot: Mutex<MigrationRecoverySnapshot>,
    pub(crate) _logging: LoggingGuard,
}

#[derive(Debug, Clone)]
pub(crate) enum MigrationRecoverySnapshot {
    AwaitingCredentials(CredentialMigrationReport),
    ReadyToRestart,
}

impl MigrationRecoveryState {
    pub(crate) fn new(
        errors: Arc<ErrorReporter>,
        coordinator: Arc<LegacyMigrationCoordinator<ElectronSafeStorageReader, OsCredentialStore>>,
        report: CredentialMigrationReport,
        logging: LoggingGuard,
    ) -> Self {
        Self {
            errors,
            coordinator,
            snapshot: Mutex::new(MigrationRecoverySnapshot::AwaitingCredentials(report)),
            _logging: logging,
        }
    }

    pub(crate) async fn snapshot(&self) -> MigrationRecoverySnapshot {
        self.snapshot.lock().await.clone()
    }

    pub(crate) async fn resume(
        &self,
        entries: Vec<CredentialReentry>,
    ) -> Result<MigrationRecoverySnapshot, MigrationError> {
        let mut snapshot = self.snapshot.lock().await;
        if matches!(*snapshot, MigrationRecoverySnapshot::ReadyToRestart) {
            return Ok(MigrationRecoverySnapshot::ReadyToRestart);
        }
        match self.coordinator.resume_with_credentials(entries).await? {
            StartupMigrationOutcome::Activated { .. } => {
                *snapshot = MigrationRecoverySnapshot::ReadyToRestart;
            }
            StartupMigrationOutcome::AwaitingCredentials { report } => {
                *snapshot = MigrationRecoverySnapshot::AwaitingCredentials(report);
            }
        }
        Ok(snapshot.clone())
    }
}
