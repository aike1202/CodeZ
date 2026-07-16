use std::{path::PathBuf, sync::Arc};

use codez_core::{AppPathError, AppPaths};
use codez_platform::ResourceLocator;
use codez_runtime::{CancellationTree, HostPreferences, ShutdownCoordinator, SystemService};
use codez_storage::{AtomicFileStore, OsCredentialStore, RecentProjectsStore};
use tauri::{App, Manager};
use thiserror::Error;

use crate::{
    error::ErrorReporter,
    logging::{self, LoggingError},
    state::AppState,
};

#[derive(Debug, Error)]
pub(crate) enum CompositionError {
    #[error("failed to resolve {kind} path: {source}")]
    ResolvePath {
        kind: &'static str,
        source: tauri::Error,
    },
    #[error(transparent)]
    InvalidPaths(#[from] AppPathError),
    #[error(transparent)]
    Logging(#[from] LoggingError),
}

pub(crate) fn compose_app_state(
    app: &App,
    pty_tx: tokio::sync::mpsc::UnboundedSender<codez_platform::pty::PtyEvent>,
) -> Result<AppState, CompositionError> {
    let path_resolver = app.path();
    let data_directory = resolve_path("application data", path_resolver.app_data_dir())?;
    let cache_directory = resolve_path("application cache", path_resolver.app_cache_dir())?;
    let log_directory = resolve_path("application log", path_resolver.app_log_dir())?;
    let resource_directory = resolve_path("application resource", path_resolver.resource_dir())?;
    let temporary_directory =
        resolve_path("temporary", path_resolver.temp_dir())?.join(&app.config().identifier);
    let home_directory = resolve_path("user home", path_resolver.home_dir())?;
    let paths = Arc::new(AppPaths::new(
        data_directory,
        cache_directory,
        log_directory,
        resource_directory,
        temporary_directory,
        home_directory,
    )?);
    let logging = logging::initialize(paths.log_directory())?;
    let storage = AtomicFileStore::default();
    let recent_projects = Arc::new(RecentProjectsStore::new(
        paths.data_directory().to_path_buf(),
        storage.clone(),
    ));

    Ok(AppState {
        system: Arc::new(SystemService::new()),
        host_preferences: Arc::new(HostPreferences::new()),
        resources: Arc::new(ResourceLocator::new(
            paths.resource_directory().to_path_buf(),
        )),
        storage: Arc::new(storage.clone()),
        recent_projects,
        credentials: Arc::new(OsCredentialStore::default()),
        cancellation: Arc::new(CancellationTree::new()),
        shutdown: Arc::new(ShutdownCoordinator::default()),
        errors: Arc::new(ErrorReporter::default()),
        attachment: Arc::new(codez_runtime::attachment::AttachmentService::new(paths.clone())),
        fingerprint: Arc::new(codez_runtime::fingerprint::ReadFingerprintStore::default()),
        mutation_coordinator: Arc::new(codez_runtime::mutation_coordinator::FileMutationCoordinator::default()),
        edit_transaction: Arc::new(codez_runtime::edit_transaction::EditTransactionService::new(paths.clone())),
        _logging: logging,
        paths: paths.clone(),
        process_runner: Arc::new(codez_platform::NativeProcessRunner::new()),
        pty_manager: Arc::new(codez_platform::PtyManager::new(pty_tx)),
        provider_service: {
            let creds = Arc::new(OsCredentialStore::default());
            let providers_path = paths.data_directory().join("user-data").join("providers.json");
            // Ensure directory exists
            std::fs::create_dir_all(providers_path.parent().unwrap()).unwrap_or_default();
            
            let service = tauri::async_runtime::block_on(
                codez_providers::service::ProviderService::new(Arc::new(storage), creds, providers_path)
            ).map_err(|e| CompositionError::ResolvePath { kind: "providers", source: tauri::Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())) })?;
            Arc::new(service)
        },
        model_ledger: Arc::new(codez_runtime::context::ledger::ModelLedgerStore::new(
            paths.data_directory().join("session-runtime")
        )),
    })
}

fn resolve_path(
    kind: &'static str,
    result: Result<PathBuf, tauri::Error>,
) -> Result<PathBuf, CompositionError> {
    result.map_err(|source| CompositionError::ResolvePath { kind, source })
}
