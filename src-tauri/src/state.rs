use std::sync::Arc;

use codez_core::AppPaths;
use codez_platform::ResourceLocator;
use codez_runtime::{CancellationTree, HostPreferences, ShutdownCoordinator, SystemService};
use codez_runtime::attachment::AttachmentService;
use codez_runtime::fingerprint::ReadFingerprintStore;
use codez_runtime::mutation_coordinator::FileMutationCoordinator;
use codez_runtime::edit_transaction::EditTransactionService;
use codez_storage::{AtomicFileStore, OsCredentialStore, RecentProjectsStore};
use codez_platform::{NativeProcessRunner, PtyManager};
use codez_providers::service::ProviderService;
use codez_runtime::context::ledger::ModelLedgerStore;

use crate::{error::ErrorReporter, logging::LoggingGuard};

pub(crate) struct AppState {
    pub(crate) system: Arc<SystemService>,
    pub(crate) host_preferences: Arc<HostPreferences>,
    pub(crate) resources: Arc<ResourceLocator>,
    pub(crate) storage: Arc<AtomicFileStore>,
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
    pub(crate) model_ledger: Arc<ModelLedgerStore>,
}
