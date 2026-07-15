use std::path::{Component, Path, PathBuf};

use thiserror::Error;

/// Canonical physical directory that acts as one workspace authority.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WorkspaceRoot {
    canonical_path: PathBuf,
}

/// Canonical path proven to remain below one [`WorkspaceRoot`].
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SafeWorkspacePath {
    root: WorkspaceRoot,
    relative_path: PathBuf,
}

/// A workspace path cannot be represented without ambient or escaping semantics.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum WorkspacePathError {
    #[error("workspace root must be absolute: {0}")]
    RootNotAbsolute(PathBuf),
    #[error("workspace root must already be canonical: {0}")]
    RootNotCanonical(PathBuf),
    #[error("workspace-relative path must not be absolute: {0}")]
    RelativePathIsAbsolute(PathBuf),
    #[error("workspace-relative path escapes its root: {0}")]
    ParentTraversal(PathBuf),
    #[error("canonical path is outside the workspace: {0}")]
    OutsideWorkspace(PathBuf),
}

impl WorkspaceRoot {
    /// Creates an authority from a path already canonicalized by a platform adapter.
    ///
    /// # Errors
    ///
    /// Returns [`WorkspacePathError`] when the path is relative or still contains
    /// `.`/`..` components. This constructor performs no filesystem I/O; the
    /// adapter must canonicalize and verify the directory before calling it.
    pub fn from_canonical(path: PathBuf) -> Result<Self, WorkspacePathError> {
        if !path.is_absolute() {
            return Err(WorkspacePathError::RootNotAbsolute(path));
        }
        if path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
        {
            return Err(WorkspacePathError::RootNotCanonical(path));
        }
        Ok(Self {
            canonical_path: path,
        })
    }

    #[must_use]
    pub fn as_path(&self) -> &Path {
        &self.canonical_path
    }
}

impl SafeWorkspacePath {
    /// Resolves and normalizes a lexical relative path below a validated root.
    ///
    /// # Errors
    ///
    /// Returns [`WorkspacePathError`] for absolute input or traversal above the
    /// workspace. Physical symlink validation remains the platform adapter's job.
    pub fn from_relative(
        root: &WorkspaceRoot,
        relative_path: &Path,
    ) -> Result<Self, WorkspacePathError> {
        if relative_path.is_absolute() {
            return Err(WorkspacePathError::RelativePathIsAbsolute(
                relative_path.to_path_buf(),
            ));
        }
        let normalized = normalize_relative(relative_path)?;
        Ok(Self {
            root: root.clone(),
            relative_path: normalized,
        })
    }

    /// Creates a safe value from a physical path canonicalized by an adapter.
    ///
    /// # Errors
    ///
    /// Returns [`WorkspacePathError`] when the target does not remain below the
    /// canonical root or its suffix contains unresolved traversal.
    pub fn from_canonical(
        root: &WorkspaceRoot,
        canonical_path: &Path,
    ) -> Result<Self, WorkspacePathError> {
        let relative = canonical_path
            .strip_prefix(root.as_path())
            .map_err(|_| WorkspacePathError::OutsideWorkspace(canonical_path.to_path_buf()))?;
        Self::from_relative(root, relative)
    }

    #[must_use]
    pub fn root(&self) -> &WorkspaceRoot {
        &self.root
    }

    #[must_use]
    pub fn relative_path(&self) -> &Path {
        &self.relative_path
    }

    #[must_use]
    pub fn absolute_path(&self) -> PathBuf {
        self.root.as_path().join(&self.relative_path)
    }

    /// Returns a stable lock/registry key with platform path-case semantics.
    #[must_use]
    pub fn identity_key(&self) -> String {
        identity_key(&self.absolute_path())
    }
}

fn normalize_relative(path: &Path) -> Result<PathBuf, WorkspacePathError> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => normalized.push(value),
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(WorkspacePathError::ParentTraversal(path.to_path_buf()));
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(WorkspacePathError::RelativePathIsAbsolute(
                    path.to_path_buf(),
                ));
            }
        }
    }
    Ok(normalized)
}

fn identity_key(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        value.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        value.into_owned()
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{SafeWorkspacePath, WorkspacePathError, WorkspaceRoot};

    fn root() -> WorkspaceRoot {
        WorkspaceRoot::from_canonical(std::env::temp_dir().join("codez-safe-workspace"))
            .expect("temporary fixture root must be absolute")
    }

    #[test]
    fn relative_paths_are_normalized_without_escaping_the_root() {
        let root = root();
        let safe = SafeWorkspacePath::from_relative(
            &root,
            &PathBuf::from("src")
                .join(".")
                .join("nested")
                .join("..")
                .join("lib.rs"),
        )
        .expect("normal in-root components must normalize");

        assert_eq!(safe.relative_path(), PathBuf::from("src/lib.rs"));
        assert_eq!(safe.absolute_path(), root.as_path().join("src/lib.rs"));
    }

    #[test]
    fn parent_traversal_and_canonical_outside_paths_are_rejected() {
        let root = root();
        let traversal =
            SafeWorkspacePath::from_relative(&root, PathBuf::from("../escape").as_path());
        let outside = SafeWorkspacePath::from_canonical(
            &root,
            std::env::temp_dir().join("outside.txt").as_path(),
        );

        assert!(matches!(
            traversal,
            Err(WorkspacePathError::ParentTraversal(_))
        ));
        assert!(matches!(
            outside,
            Err(WorkspacePathError::OutsideWorkspace(_))
        ));
    }

    #[cfg(windows)]
    #[test]
    fn identity_keys_use_windows_case_insensitive_semantics() {
        let root = root();
        let lower = SafeWorkspacePath::from_relative(&root, PathBuf::from("src/lib.rs").as_path())
            .expect("lowercase path must be valid");
        let upper = SafeWorkspacePath::from_relative(&root, PathBuf::from("SRC/LIB.RS").as_path())
            .expect("uppercase path must be valid");

        assert_eq!(lower.identity_key(), upper.identity_key());
    }
}
