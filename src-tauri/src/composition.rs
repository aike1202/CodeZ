use std::{path::PathBuf, sync::Arc};

use codez_core::{AppPathError, AppPaths};
use codez_platform::ResourceLocator;
use codez_runtime::{HostPreferences, ShutdownCoordinator, SystemService};
use codez_storage::{AtomicFileStore, OsCredentialStore};
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

pub(crate) fn compose_app_state(app: &App) -> Result<AppState, CompositionError> {
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

    Ok(AppState {
        system: Arc::new(SystemService::new()),
        host_preferences: Arc::new(HostPreferences::new()),
        resources: Arc::new(ResourceLocator::new(
            paths.resource_directory().to_path_buf(),
        )),
        storage: Arc::new(AtomicFileStore::default()),
        credentials: Arc::new(OsCredentialStore::default()),
        shutdown: Arc::new(ShutdownCoordinator::default()),
        errors: Arc::new(ErrorReporter::default()),
        _logging: logging,
        paths,
    })
}

fn resolve_path(
    kind: &'static str,
    result: Result<PathBuf, tauri::Error>,
) -> Result<PathBuf, CompositionError> {
    result.map_err(|source| CompositionError::ResolvePath { kind, source })
}
