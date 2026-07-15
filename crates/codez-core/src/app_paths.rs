use std::path::{Component, Path, PathBuf};

use thiserror::Error;

/// Validated application-owned roots supplied by the desktop composition layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    data_directory: PathBuf,
    cache_directory: PathBuf,
    log_directory: PathBuf,
    resource_directory: PathBuf,
    temporary_directory: PathBuf,
    home_directory: PathBuf,
}

/// An application or workspace root is not safe to use as a path authority.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum AppPathError {
    /// The supplied root was relative to an ambient current directory.
    #[error("{kind} path must be absolute: {path}")]
    NotAbsolute { kind: &'static str, path: PathBuf },
    /// The supplied root contained an unresolved parent traversal component.
    #[error("{kind} path must not contain parent traversal: {path}")]
    ParentTraversal { kind: &'static str, path: PathBuf },
}

impl AppPaths {
    /// Creates application paths from roots resolved by the desktop host.
    ///
    /// # Errors
    ///
    /// Returns [`AppPathError`] when any root is relative or contains an
    /// unresolved `..` component.
    pub fn new(
        data_directory: PathBuf,
        cache_directory: PathBuf,
        log_directory: PathBuf,
        resource_directory: PathBuf,
        temporary_directory: PathBuf,
        home_directory: PathBuf,
    ) -> Result<Self, AppPathError> {
        Ok(Self {
            data_directory: validate_root("application data", data_directory)?,
            cache_directory: validate_root("application cache", cache_directory)?,
            log_directory: validate_root("application log", log_directory)?,
            resource_directory: validate_root("application resource", resource_directory)?,
            temporary_directory: validate_root("application temporary", temporary_directory)?,
            home_directory: validate_root("user home", home_directory)?,
        })
    }

    /// Returns the authoritative root for durable application data.
    #[must_use]
    pub fn data_directory(&self) -> &Path {
        &self.data_directory
    }

    /// Returns the authoritative root for disposable application caches.
    #[must_use]
    pub fn cache_directory(&self) -> &Path {
        &self.cache_directory
    }

    /// Returns the authoritative root for local diagnostic logs.
    #[must_use]
    pub fn log_directory(&self) -> &Path {
        &self.log_directory
    }

    /// Returns the immutable resource root supplied by Tauri.
    #[must_use]
    pub fn resource_directory(&self) -> &Path {
        &self.resource_directory
    }

    /// Returns the application-specific temporary root.
    #[must_use]
    pub fn temporary_directory(&self) -> &Path {
        &self.temporary_directory
    }

    /// Returns the current user's home directory.
    #[must_use]
    pub fn home_directory(&self) -> &Path {
        &self.home_directory
    }

    /// Returns the global user-authored CodeZ state directory.
    #[must_use]
    pub fn user_state_directory(&self) -> PathBuf {
        self.home_directory.join(".codez")
    }

    /// Returns the directory used for versioned migration state and backups.
    #[must_use]
    pub fn migration_directory(&self) -> PathBuf {
        self.data_directory.join("migrations")
    }

    /// Derives the durable `.codez` state directory for a workspace root.
    ///
    /// # Errors
    ///
    /// Returns [`AppPathError`] when `workspace_root` is relative or contains
    /// unresolved parent traversal.
    pub fn workspace_state_directory(
        &self,
        workspace_root: &Path,
    ) -> Result<PathBuf, AppPathError> {
        validate_borrowed_root("workspace", workspace_root)?;
        Ok(workspace_root.join(".codez"))
    }

    /// Derives the disposable `.codez-cache` directory for a workspace root.
    ///
    /// # Errors
    ///
    /// Returns [`AppPathError`] when `workspace_root` is relative or contains
    /// unresolved parent traversal.
    pub fn workspace_cache_directory(
        &self,
        workspace_root: &Path,
    ) -> Result<PathBuf, AppPathError> {
        validate_borrowed_root("workspace", workspace_root)?;
        Ok(workspace_root.join(".codez-cache"))
    }
}

fn validate_root(kind: &'static str, path: PathBuf) -> Result<PathBuf, AppPathError> {
    validate_borrowed_root(kind, &path)?;
    Ok(path)
}

fn validate_borrowed_root(kind: &'static str, path: &Path) -> Result<(), AppPathError> {
    if !path.is_absolute() {
        return Err(AppPathError::NotAbsolute {
            kind,
            path: path.to_path_buf(),
        });
    }
    if path
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return Err(AppPathError::ParentTraversal {
            kind,
            path: path.to_path_buf(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{AppPathError, AppPaths};

    fn fixture_root(name: &str) -> PathBuf {
        std::env::temp_dir().join("codez-app-paths").join(name)
    }

    fn fixture_paths() -> AppPaths {
        AppPaths::new(
            fixture_root("data"),
            fixture_root("cache"),
            fixture_root("logs"),
            fixture_root("resources"),
            fixture_root("temporary"),
            fixture_root("home"),
        )
        .expect("fixture paths are absolute")
    }

    #[test]
    fn app_paths_reject_relative_roots() {
        let result = AppPaths::new(
            PathBuf::from("relative-data"),
            fixture_root("cache"),
            fixture_root("logs"),
            fixture_root("resources"),
            fixture_root("temporary"),
            fixture_root("home"),
        );

        assert!(matches!(result, Err(AppPathError::NotAbsolute { .. })));
    }

    #[test]
    fn workspace_directories_are_derived_from_a_validated_root() {
        let paths = fixture_paths();
        let workspace = fixture_root("workspace");

        assert_eq!(
            (
                paths
                    .workspace_state_directory(&workspace)
                    .expect("fixture workspace is absolute"),
                paths
                    .workspace_cache_directory(&workspace)
                    .expect("fixture workspace is absolute"),
            ),
            (workspace.join(".codez"), workspace.join(".codez-cache"))
        );
    }
}
