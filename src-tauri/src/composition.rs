use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use codez_core::{AppError, AppPathError, AppPaths, AtomicPersistence};
use codez_mcp::{McpSecretService, McpUserConfigService};
use codez_platform::ResourceLocator;
use codez_runtime::{
    CancellationTree, HostPreferences, ShutdownCoordinator, SystemService,
    permission::store::{PermissionStoreError, WorkspacePermissionStore},
};
use codez_storage::{
    AtomicFileStore, DiscoveryLimits, ElectronSafeStorageReader, LegacyMigrationCoordinator,
    LegacyMigrationService, LegacyRoots, MigrationActivationService, MigrationError,
    MigrationRunId, OsCredentialStore, RecentProjectsStore, StartupMigrationOutcome, StorageError,
};
use tauri::{App, Manager};
use thiserror::Error;

use crate::{
    chat_runtime::ChatRuntime,
    error::ErrorReporter,
    logging::{self, LoggingError},
    mcp_boundary::StorageMcpSecretStore,
    provider_boundary::{StorageProviderCredentials, StorageProviderRepository},
    state::AppState,
};

#[derive(Debug, Error)]
pub(crate) enum CompositionError {
    #[error("failed to resolve {kind} path: {source}")]
    ResolvePath {
        kind: &'static str,
        source: tauri::Error,
    },
    #[error("failed to initialize {kind} directory {path}: {source}")]
    InitializeDirectory {
        kind: &'static str,
        path: PathBuf,
        source: std::io::Error,
    },
    #[error(transparent)]
    InvalidPaths(#[from] AppPathError),
    #[error(transparent)]
    Logging(#[from] LoggingError),
    #[error(transparent)]
    MigrationStorage(#[from] StorageError),
    #[error(transparent)]
    Migration(#[from] MigrationError),
    #[error("legacy migration requires {count} credential value(s) to be entered again")]
    MigrationCredentials { count: usize },
    #[error("failed to inspect legacy user-data path {path}: {source}")]
    InspectLegacyUserData {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error(
        "both legacy user-data directories contain data and cannot be merged automatically: {primary}, {alternate}"
    )]
    AmbiguousLegacyUserData {
        primary: PathBuf,
        alternate: PathBuf,
    },
    #[error("failed to initialize provider storage: {source}")]
    Provider {
        #[source]
        source: AppError,
    },
    #[error("failed to initialize permission storage: {source}")]
    Permission {
        #[from]
        source: PermissionStoreError,
    },
}

pub(crate) fn compose_app_state(
    app: &App,
    pty_tx: tokio::sync::mpsc::Sender<codez_platform::pty::PtyEvent>,
) -> Result<AppState, CompositionError> {
    let path_resolver = app.path();
    let home_directory = resolve_path("user home", path_resolver.home_dir())?;
    let legacy_config_directory = resolve_path("legacy config", path_resolver.config_dir())?;
    let legacy_user_data = resolve_legacy_user_data(&legacy_config_directory)?;
    let resource_directory = resolve_path("application resource", path_resolver.resource_dir())?;
    let paths = Arc::new(AppPaths::for_user_home(home_directory, resource_directory)?);

    ensure_directory("application data", paths.data_directory())?;
    ensure_directory("application cache", paths.cache_directory())?;
    ensure_directory("application log", paths.log_directory())?;
    ensure_directory("application temporary", paths.temporary_directory())?;
    ensure_directory("application migration", &paths.migration_directory())?;
    let logging = logging::initialize(paths.log_directory())?;
    let storage = Arc::new(AtomicFileStore::default());
    let persistence: Arc<dyn AtomicPersistence> = storage.clone();
    let credentials = Arc::new(OsCredentialStore::default());
    let cancellation = Arc::new(CancellationTree::new());
    let errors = Arc::new(ErrorReporter::default());
    let chat_runtime = Arc::new(ChatRuntime::new(
        Arc::clone(&cancellation),
        Arc::clone(&errors),
    ));
    run_startup_migration(&paths, legacy_user_data, Arc::clone(&credentials))?;
    let recent_projects = Arc::new(RecentProjectsStore::new(
        paths.data_directory().to_path_buf(),
        storage.as_ref().clone(),
    ));

    Ok(AppState {
        system: Arc::new(SystemService::new()),
        host_preferences: Arc::new(HostPreferences::new()),
        resources: Arc::new(ResourceLocator::new(
            paths.resource_directory().to_path_buf(),
        )),
        storage: Arc::clone(&storage),
        persistence: Arc::clone(&persistence),
        recent_projects,
        credentials: Arc::clone(&credentials),
        cancellation,
        shutdown: Arc::new(ShutdownCoordinator::default()),
        errors,
        attachment: Arc::new(codez_runtime::attachment::AttachmentService::new(
            paths.clone(),
        )),
        fingerprint: Arc::new(codez_runtime::fingerprint::ReadFingerprintStore::default()),
        mutation_coordinator: Arc::new(
            codez_runtime::mutation_coordinator::FileMutationCoordinator::default(),
        ),
        edit_transaction: Arc::new(
            codez_runtime::edit_transaction::EditTransactionService::new(paths.clone()),
        ),
        _logging: logging,
        paths: paths.clone(),
        process_runner: Arc::new(codez_platform::NativeProcessRunner::new()),
        pty_manager: Arc::new(codez_platform::PtyManager::new(pty_tx)),
        provider_service: {
            let providers_path = paths.data_directory().join("providers.json");
            let repository = Arc::new(StorageProviderRepository::new(
                Arc::clone(&storage),
                providers_path,
            ));
            let provider_credentials =
                Arc::new(StorageProviderCredentials::new(credentials.clone()));
            let service = tauri::async_runtime::block_on(
                codez_providers::service::ProviderService::new(repository, provider_credentials),
            )
            .map_err(|source| CompositionError::Provider { source })?;
            Arc::new(service)
        },
        workspace_permissions: Arc::new(WorkspacePermissionStore::new(
            paths.data_directory(),
            Arc::clone(&persistence),
        )?),
        mcp_config: Arc::new(McpUserConfigService::new(
            Arc::clone(&persistence),
            paths.data_directory().join("mcp.json"),
        )),
        mcp_secrets: Arc::new(McpSecretService::new(
            Arc::clone(&persistence),
            paths.data_directory().join("mcp-secret-index.json"),
            Arc::new(StorageMcpSecretStore::new(credentials.clone())),
        )),
        model_ledger: Arc::new(codez_runtime::context::ledger::ModelLedgerStore::new(
            paths.data_directory().join("session-runtime"),
            persistence,
        )),
        chat_runtime,
    })
}

fn resolve_legacy_user_data(config_directory: &Path) -> Result<PathBuf, CompositionError> {
    let primary = config_directory.join("CodeZ");
    let alternate = config_directory.join("codez");
    let primary_state = inspect_legacy_directory(&primary)?;
    let alternate_state = inspect_legacy_directory(&alternate)?;

    match (primary_state, alternate_state) {
        (None, None) | (Some(_), None) => Ok(primary),
        (None, Some(_)) => Ok(alternate),
        (Some(primary_has_data), Some(alternate_has_data)) => {
            if same_file::is_same_file(&primary, &alternate).map_err(|source| {
                CompositionError::InspectLegacyUserData {
                    path: alternate.clone(),
                    source,
                }
            })? {
                return Ok(primary);
            }
            match (primary_has_data, alternate_has_data) {
                (false, true) => Ok(alternate),
                (true, true) => {
                    Err(CompositionError::AmbiguousLegacyUserData { primary, alternate })
                }
                (true, false) | (false, false) => Ok(primary),
            }
        }
    }
}

fn inspect_legacy_directory(path: &Path) -> Result<Option<bool>, CompositionError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(CompositionError::InspectLegacyUserData {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    if !metadata.is_dir() {
        return Ok(Some(true));
    }
    let mut entries =
        fs::read_dir(path).map_err(|source| CompositionError::InspectLegacyUserData {
            path: path.to_path_buf(),
            source,
        })?;
    entries
        .next()
        .transpose()
        .map(|entry| Some(entry.is_some()))
        .map_err(|source| CompositionError::InspectLegacyUserData {
            path: path.to_path_buf(),
            source,
        })
}

fn run_startup_migration(
    paths: &AppPaths,
    legacy_user_data: PathBuf,
    credentials: Arc<OsCredentialStore>,
) -> Result<(), CompositionError> {
    const MIGRATION_MAX_DOCUMENT_BYTES: u64 = 256 * 1024 * 1024;
    const GLOBAL_MIGRATION_RUN_ID: &str = "legacy-global-v1";

    let migration_files = AtomicFileStore::with_max_document_bytes(MIGRATION_MAX_DOCUMENT_BYTES)?;
    let workspaces = legacy_workspace_roots(&legacy_user_data);
    let roots = LegacyRoots::new(
        legacy_user_data.clone(),
        paths.home_directory().to_path_buf(),
        workspaces,
    )?;
    let migration_directory = paths.migration_directory();
    let coordinator = LegacyMigrationCoordinator::new(
        LegacyMigrationService::new(migration_files.clone(), DiscoveryLimits::default()),
        MigrationActivationService::new(migration_files),
        roots,
        paths.data_directory().to_path_buf(),
        migration_directory.join("backups"),
        migration_directory.join("staging"),
        MigrationRunId::parse(GLOBAL_MIGRATION_RUN_ID)?,
        Arc::new(ElectronSafeStorageReader::from_user_data(&legacy_user_data)),
        credentials,
    );
    let outcome = tauri::async_runtime::block_on(coordinator.run())?;
    match outcome {
        StartupMigrationOutcome::Activated { commit, activation } => {
            tracing::info!(
                migration_run = commit.run_id.as_str(),
                activated_files = activation.files.len(),
                "legacy data repository is committed and active"
            );
            Ok(())
        }
        StartupMigrationOutcome::AwaitingCredentials { report } => {
            Err(CompositionError::MigrationCredentials {
                count: report.requires_reentry,
            })
        }
    }
}

fn legacy_workspace_roots(legacy_user_data: &Path) -> Vec<PathBuf> {
    const MAX_RECENT_PROJECT_BYTES: u64 = 16 * 1024 * 1024;
    const MAX_MIGRATION_WORKSPACES: usize = 100;

    let path = legacy_user_data.join("recent-projects.json");
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return Vec::new();
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_RECENT_PROJECT_BYTES
    {
        return Vec::new();
    }
    let Ok(bytes) = fs::read(path) else {
        return Vec::new();
    };
    let Ok(document) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Vec::new();
    };
    let Some(projects) = document
        .get("projects")
        .and_then(serde_json::Value::as_array)
    else {
        return Vec::new();
    };
    let mut roots = projects
        .iter()
        .filter_map(|project| {
            project
                .get("rootPath")
                .or_else(|| project.get("path"))
                .and_then(serde_json::Value::as_str)
                .map(PathBuf::from)
        })
        .filter(|path| path.is_absolute())
        .take(MAX_MIGRATION_WORKSPACES)
        .collect::<Vec<_>>();
    roots.sort_unstable();
    roots.dedup();
    roots
}

fn resolve_path(
    kind: &'static str,
    result: Result<PathBuf, tauri::Error>,
) -> Result<PathBuf, CompositionError> {
    result.map_err(|source| CompositionError::ResolvePath { kind, source })
}

fn ensure_directory(kind: &'static str, path: &Path) -> Result<(), CompositionError> {
    fs::create_dir_all(path).map_err(|source| CompositionError::InitializeDirectory {
        kind,
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{CompositionError, resolve_legacy_user_data};

    #[test]
    fn legacy_user_data_uses_the_lowercase_directory_when_it_is_the_only_source() {
        let directory = tempfile::tempdir().expect("legacy path fixture must exist");
        let lowercase = directory.path().join("codez");
        fs::create_dir(&lowercase).expect("lowercase legacy directory must be created");
        fs::write(lowercase.join("providers.json"), b"{}")
            .expect("lowercase legacy fixture must be written");

        let resolved = resolve_legacy_user_data(directory.path())
            .expect("a single legacy directory must resolve");

        assert!(
            same_file::is_same_file(resolved, lowercase)
                .expect("resolved legacy directory identity must be readable")
        );
    }

    #[test]
    fn legacy_user_data_rejects_two_distinct_nonempty_sources() {
        let directory = tempfile::tempdir().expect("legacy path fixture must exist");
        let primary = directory.path().join("CodeZ");
        let alternate = directory.path().join("codez");
        fs::create_dir(&primary).expect("primary legacy directory must be created");
        if fs::create_dir(&alternate).is_err() {
            return;
        }
        fs::write(primary.join("providers.json"), b"{}")
            .expect("primary legacy fixture must be written");
        fs::write(alternate.join("sessions.json"), b"{}")
            .expect("alternate legacy fixture must be written");

        let error = resolve_legacy_user_data(directory.path())
            .expect_err("two distinct populated legacy roots must not be selected implicitly");

        assert!(matches!(
            error,
            CompositionError::AmbiguousLegacyUserData { .. }
        ));
    }
}
