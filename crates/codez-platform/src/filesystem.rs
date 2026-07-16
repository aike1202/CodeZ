use std::{
    ffi::OsString,
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use codez_core::{
    AppError, DirectoryEntry, DirectoryListing, FileKind, FileMetadata, FileSystem, PortFuture,
    SafeWorkspacePath, WorkspacePathError, WorkspaceRoot,
};
use same_file::Handle;
use tempfile::Builder;
use thiserror::Error;

/// Native workspace filesystem failure retained inside the adapter boundary.
#[derive(Debug, Error)]
pub enum NativeFileSystemError {
    #[error(transparent)]
    WorkspacePath(#[from] WorkspacePathError),
    #[error("workspace path belongs to a different root: {0}")]
    AuthorityMismatch(PathBuf),
    #[error("workspace root identity changed after it was opened: {0}")]
    RootChanged(PathBuf),
    #[error("workspace path identity changed after validation: {0}")]
    PathChanged(PathBuf),
    #[error("workspace path is a symbolic link or unsupported file type: {0}")]
    UnsafeFileType(PathBuf),
    #[error("workspace file exceeds its {max_bytes}-byte read limit: {path}")]
    FileTooLarge { path: PathBuf, max_bytes: u64 },
    #[error("workspace file read limit must be positive")]
    InvalidReadLimit,
    #[error("workspace directory entry limit must be positive")]
    InvalidDirectoryLimit,
    #[error("workspace filesystem failed to {operation}: {path}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("workspace filesystem worker failed while attempting to {operation}")]
    TaskJoin {
        operation: &'static str,
        #[source]
        source: tokio::task::JoinError,
    },
}

impl NativeFileSystemError {
    fn into_app_error(self) -> AppError {
        match self {
            Self::WorkspacePath(WorkspacePathError::OutsideWorkspace(_))
            | Self::UnsafeFileType(_) => {
                AppError::permission_denied("The workspace path is not allowed")
            }
            Self::WorkspacePath(_) => AppError::validation("Invalid workspace path"),
            Self::FileTooLarge { .. } => {
                AppError::validation("The workspace file exceeds the read limit")
            }
            Self::InvalidReadLimit => {
                AppError::validation("The workspace read limit must be positive")
            }
            Self::InvalidDirectoryLimit => {
                AppError::validation("The workspace directory limit must be positive")
            }
            Self::AuthorityMismatch(_) | Self::RootChanged(_) | Self::PathChanged(_) => {
                AppError::conflict("The workspace path changed; retry the operation")
            }
            Self::Io { source, .. } if source.kind() == io::ErrorKind::NotFound => {
                AppError::not_found("The workspace path does not exist")
            }
            Self::Io { source, .. } if source.kind() == io::ErrorKind::PermissionDenied => {
                AppError::permission_denied("The workspace path is not accessible")
            }
            Self::Io { .. } => AppError::external(
                "The workspace filesystem operation failed",
                self.to_string(),
                true,
            ),
            Self::TaskJoin { .. } => AppError::internal(self.to_string()),
        }
    }
}

impl From<NativeFileSystemError> for AppError {
    fn from(value: NativeFileSystemError) -> Self {
        value.into_app_error()
    }
}

struct WorkspaceAuthority {
    root: WorkspaceRoot,
    identity: Handle,
}

/// Filesystem adapter bound to one canonical workspace authority.
#[derive(Clone)]
pub struct NativeFileSystem {
    authority: Arc<WorkspaceAuthority>,
}

impl std::fmt::Debug for NativeFileSystem {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeFileSystem")
            .field("root", &self.authority.root)
            .finish_non_exhaustive()
    }
}

impl NativeFileSystem {
    /// Opens and canonicalizes one existing workspace directory.
    ///
    /// # Errors
    ///
    /// Returns [`NativeFileSystemError`] when the root is missing, is not a
    /// directory, cannot be canonicalized, or the worker cannot be joined.
    pub async fn open(root: PathBuf) -> Result<Self, NativeFileSystemError> {
        tokio::task::spawn_blocking(move || open_blocking(&root))
            .await
            .map_err(|source| NativeFileSystemError::TaskJoin {
                operation: "open workspace root",
                source,
            })?
    }

    #[must_use]
    pub fn root(&self) -> &WorkspaceRoot {
        &self.authority.root
    }

    /// Resolves untrusted absolute or workspace-relative input to a physical path.
    ///
    /// Existing symlinks are collapsed to their physical target. Missing suffixes
    /// are appended only after the nearest existing ancestor is canonicalized.
    ///
    /// # Errors
    ///
    /// Returns [`NativeFileSystemError`] when the root changed, relative input
    /// escapes lexically, or the physical target leaves the workspace.
    pub async fn resolve(
        &self,
        requested: PathBuf,
    ) -> Result<SafeWorkspacePath, NativeFileSystemError> {
        let authority = Arc::clone(&self.authority);
        tokio::task::spawn_blocking(move || resolve_blocking(&authority, &requested))
            .await
            .map_err(|source| NativeFileSystemError::TaskJoin {
                operation: "resolve workspace path",
                source,
            })?
    }
}

impl FileSystem for NativeFileSystem {
    fn workspace_root(&self) -> &WorkspaceRoot {
        &self.authority.root
    }

    fn resolve<'a>(&'a self, requested: &'a Path) -> PortFuture<'a, SafeWorkspacePath> {
        let filesystem = self.clone();
        let requested = requested.to_path_buf();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || resolve_blocking(&filesystem.authority, &requested))
                .await
                .map_err(|source| NativeFileSystemError::TaskJoin {
                    operation: "resolve workspace path",
                    source,
                })?
                .map_err(NativeFileSystemError::into_app_error)
        })
    }

    fn metadata<'a>(&'a self, path: &'a SafeWorkspacePath) -> PortFuture<'a, FileMetadata> {
        let filesystem = self.clone();
        let path = path.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || metadata_blocking(&filesystem.authority, &path))
                .await
                .map_err(|source| NativeFileSystemError::TaskJoin {
                    operation: "read workspace metadata",
                    source,
                })?
                .map_err(NativeFileSystemError::into_app_error)
        })
    }

    fn read_directory<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        max_entries: usize,
    ) -> PortFuture<'a, DirectoryListing> {
        let filesystem = self.clone();
        let path = path.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                read_directory_blocking(&filesystem.authority, &path, max_entries)
            })
            .await
            .map_err(|source| NativeFileSystemError::TaskJoin {
                operation: "read workspace directory",
                source,
            })?
            .map_err(NativeFileSystemError::into_app_error)
        })
    }

    fn read_bounded<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        max_bytes: u64,
    ) -> PortFuture<'a, Vec<u8>> {
        let filesystem = self.clone();
        let path = path.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                read_bounded_blocking(&filesystem.authority, &path, max_bytes)
            })
            .await
            .map_err(|source| NativeFileSystemError::TaskJoin {
                operation: "read workspace file",
                source,
            })?
            .map_err(NativeFileSystemError::into_app_error)
        })
    }

    fn write_atomic<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        bytes: &'a [u8],
    ) -> PortFuture<'a, ()> {
        let filesystem = self.clone();
        let path = path.clone();
        let bytes = bytes.to_vec();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                write_atomic_blocking(&filesystem.authority, &path, &bytes)
            })
            .await
            .map_err(|source| NativeFileSystemError::TaskJoin {
                operation: "write workspace file",
                source,
            })?
            .map_err(NativeFileSystemError::into_app_error)
        })
    }
}

fn open_blocking(root: &Path) -> Result<NativeFileSystem, NativeFileSystemError> {
    let canonical = dunce::canonicalize(root)
        .map_err(|source| io_error("canonicalize workspace root", root, source))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|source| io_error("inspect workspace root", &canonical, source))?;
    if !metadata.is_dir() {
        return Err(NativeFileSystemError::UnsafeFileType(canonical));
    }
    let identity = Handle::from_path(&canonical)
        .map_err(|source| io_error("open workspace root identity", &canonical, source))?;
    let root = WorkspaceRoot::from_canonical(canonical)?;
    Ok(NativeFileSystem {
        authority: Arc::new(WorkspaceAuthority { root, identity }),
    })
}

fn resolve_blocking(
    authority: &WorkspaceAuthority,
    requested: &Path,
) -> Result<SafeWorkspacePath, NativeFileSystemError> {
    ensure_root_stable(authority)?;
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        SafeWorkspacePath::from_relative(&authority.root, requested)?.absolute_path()
    };
    canonical_candidate(&authority.root, &candidate)
}

fn canonical_candidate(
    root: &WorkspaceRoot,
    candidate: &Path,
) -> Result<SafeWorkspacePath, NativeFileSystemError> {
    let candidate = std::path::absolute(candidate)
        .map_err(|source| io_error("normalize workspace path", candidate, source))?;
    let (ancestor, suffix) = nearest_existing_ancestor(&candidate)?;
    let canonical_ancestor = dunce::canonicalize(&ancestor)
        .map_err(|source| io_error("canonicalize workspace ancestor", &ancestor, source))?;
    let mut canonical_target = canonical_ancestor;
    for component in suffix {
        canonical_target.push(component);
    }
    SafeWorkspacePath::from_canonical(root, &canonical_target).map_err(Into::into)
}

fn nearest_existing_ancestor(
    candidate: &Path,
) -> Result<(PathBuf, Vec<OsString>), NativeFileSystemError> {
    let mut current = candidate.to_path_buf();
    let mut suffix = Vec::new();
    loop {
        match fs::symlink_metadata(&current) {
            Ok(_) => {
                suffix.reverse();
                return Ok((current, suffix));
            }
            Err(source) if source.kind() == io::ErrorKind::NotFound => {
                let name = current.file_name().ok_or_else(|| {
                    io_error(
                        "find existing workspace ancestor",
                        candidate,
                        io::Error::new(io::ErrorKind::NotFound, "no existing ancestor"),
                    )
                })?;
                suffix.push(name.to_os_string());
                current = current
                    .parent()
                    .ok_or_else(|| {
                        io_error(
                            "find existing workspace ancestor",
                            candidate,
                            io::Error::new(io::ErrorKind::NotFound, "no parent directory"),
                        )
                    })?
                    .to_path_buf();
            }
            Err(source) => {
                return Err(io_error("inspect workspace ancestor", &current, source));
            }
        }
    }
}

fn ensure_root_stable(authority: &WorkspaceAuthority) -> Result<(), NativeFileSystemError> {
    let root = authority.root.as_path();
    let canonical = dunce::canonicalize(root)
        .map_err(|source| io_error("revalidate workspace root", root, source))?;
    let current = Handle::from_path(root)
        .map_err(|source| io_error("reopen workspace root identity", root, source))?;
    if path_identity_key(&canonical) != path_identity_key(root) || current != authority.identity {
        return Err(NativeFileSystemError::RootChanged(root.to_path_buf()));
    }
    Ok(())
}

fn revalidate_path(
    authority: &WorkspaceAuthority,
    path: &SafeWorkspacePath,
) -> Result<PathBuf, NativeFileSystemError> {
    if path.root() != &authority.root {
        return Err(NativeFileSystemError::AuthorityMismatch(
            path.absolute_path(),
        ));
    }
    ensure_root_stable(authority)?;
    let current = canonical_candidate(&authority.root, &path.absolute_path())?;
    if current.identity_key() != path.identity_key() {
        return Err(NativeFileSystemError::PathChanged(path.absolute_path()));
    }
    Ok(current.absolute_path())
}

fn metadata_blocking(
    authority: &WorkspaceAuthority,
    path: &SafeWorkspacePath,
) -> Result<FileMetadata, NativeFileSystemError> {
    let absolute = revalidate_path(authority, path)?;
    let metadata = fs::symlink_metadata(&absolute)
        .map_err(|source| io_error("read workspace metadata", &absolute, source))?;
    let kind = if metadata.file_type().is_symlink() {
        return Err(NativeFileSystemError::UnsafeFileType(absolute));
    } else if metadata.is_file() {
        FileKind::File
    } else if metadata.is_dir() {
        FileKind::Directory
    } else {
        FileKind::Other
    };
    Ok(FileMetadata {
        kind,
        byte_length: metadata.len(),
    })
}

fn read_directory_blocking(
    authority: &WorkspaceAuthority,
    path: &SafeWorkspacePath,
    max_entries: usize,
) -> Result<DirectoryListing, NativeFileSystemError> {
    if max_entries == 0 {
        return Err(NativeFileSystemError::InvalidDirectoryLimit);
    }
    let absolute = revalidate_path(authority, path)?;
    let metadata = fs::symlink_metadata(&absolute)
        .map_err(|source| io_error("inspect workspace directory", &absolute, source))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(NativeFileSystemError::UnsafeFileType(absolute));
    }
    let opened_identity = Handle::from_path(&absolute)
        .map_err(|source| io_error("open workspace directory identity", &absolute, source))?;
    let directory = fs::read_dir(&absolute)
        .map_err(|source| io_error("read workspace directory", &absolute, source))?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for (index, entry) in directory.enumerate() {
        if index >= max_entries {
            truncated = true;
            break;
        }
        let entry = entry
            .map_err(|source| io_error("read workspace directory entry", &absolute, source))?;
        let entry_path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|source| io_error("inspect workspace directory entry", &entry_path, source))?;
        if file_type.is_symlink() {
            continue;
        }
        let kind = if file_type.is_file() {
            FileKind::File
        } else if file_type.is_dir() {
            FileKind::Directory
        } else {
            FileKind::Other
        };
        let metadata = entry
            .metadata()
            .map_err(|source| io_error("read workspace entry metadata", &entry_path, source))?;
        let safe_path = SafeWorkspacePath::from_canonical(&authority.root, &entry_path)?;
        entries.push(DirectoryEntry {
            name: entry.file_name(),
            path: safe_path,
            kind,
            byte_length: metadata.len(),
        });
    }
    let current = revalidate_path(authority, path)?;
    let current_identity = Handle::from_path(&current)
        .map_err(|source| io_error("recheck workspace directory identity", &current, source))?;
    if current_identity != opened_identity {
        return Err(NativeFileSystemError::PathChanged(absolute));
    }
    Ok(DirectoryListing { entries, truncated })
}

fn read_bounded_blocking(
    authority: &WorkspaceAuthority,
    path: &SafeWorkspacePath,
    max_bytes: u64,
) -> Result<Vec<u8>, NativeFileSystemError> {
    if max_bytes == 0 {
        return Err(NativeFileSystemError::InvalidReadLimit);
    }
    let absolute = revalidate_path(authority, path)?;
    let metadata = fs::symlink_metadata(&absolute)
        .map_err(|source| io_error("inspect workspace file", &absolute, source))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(NativeFileSystemError::UnsafeFileType(absolute));
    }
    if metadata.len() > max_bytes {
        return Err(NativeFileSystemError::FileTooLarge {
            path: absolute,
            max_bytes,
        });
    }

    let file = File::open(&absolute)
        .map_err(|source| io_error("open workspace file", &absolute, source))?;
    let opened_identity = Handle::from_file(
        file.try_clone()
            .map_err(|source| io_error("clone workspace file handle", &absolute, source))?,
    )
    .map_err(|source| io_error("inspect open workspace file", &absolute, source))?;
    verify_open_identity(authority, path, &absolute, &opened_identity)?;

    let capacity = metadata
        .len()
        .min(max_bytes)
        .min(1024 * 1024)
        .try_into()
        .unwrap_or(1024 * 1024);
    let mut bytes = Vec::with_capacity(capacity);
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|source| io_error("read workspace file", &absolute, source))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > max_bytes {
        return Err(NativeFileSystemError::FileTooLarge {
            path: absolute,
            max_bytes,
        });
    }
    verify_open_identity(authority, path, &absolute, &opened_identity)?;
    Ok(bytes)
}

fn verify_open_identity(
    authority: &WorkspaceAuthority,
    path: &SafeWorkspacePath,
    absolute: &Path,
    opened_identity: &Handle,
) -> Result<(), NativeFileSystemError> {
    let current = revalidate_path(authority, path)?;
    if path_identity_key(&current) != path_identity_key(absolute) {
        return Err(NativeFileSystemError::PathChanged(absolute.to_path_buf()));
    }
    let current_identity = Handle::from_path(&current)
        .map_err(|source| io_error("reopen workspace file identity", &current, source))?;
    if &current_identity != opened_identity {
        return Err(NativeFileSystemError::PathChanged(absolute.to_path_buf()));
    }
    Ok(())
}

fn write_atomic_blocking(
    authority: &WorkspaceAuthority,
    path: &SafeWorkspacePath,
    bytes: &[u8],
) -> Result<(), NativeFileSystemError> {
    if path.relative_path().as_os_str().is_empty() {
        return Err(NativeFileSystemError::UnsafeFileType(path.absolute_path()));
    }
    ensure_parent_directories(authority, path)?;
    let absolute = revalidate_path(authority, path)?;
    let parent = absolute
        .parent()
        .ok_or_else(|| NativeFileSystemError::UnsafeFileType(absolute.clone()))?;
    let parent_identity = Handle::from_path(parent)
        .map_err(|source| io_error("open workspace parent identity", parent, source))?;
    let before = regular_file_identity(&absolute)?;
    let before_permissions = match fs::symlink_metadata(&absolute) {
        Ok(metadata) => Some(metadata.permissions()),
        Err(source) if source.kind() == io::ErrorKind::NotFound => None,
        Err(source) => return Err(io_error("inspect workspace target", &absolute, source)),
    };

    let mut temporary = Builder::new()
        .prefix(".codez-workspace-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|source| io_error("create workspace temporary file", &absolute, source))?;
    if let Some(permissions) = before_permissions {
        temporary
            .as_file()
            .set_permissions(permissions)
            .map_err(|source| io_error("preserve workspace file permissions", &absolute, source))?;
    }
    temporary
        .write_all(bytes)
        .map_err(|source| io_error("write workspace temporary file", &absolute, source))?;
    temporary
        .flush()
        .map_err(|source| io_error("flush workspace temporary file", &absolute, source))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|source| io_error("sync workspace temporary file", &absolute, source))?;

    let current = revalidate_path(authority, path)?;
    if path_identity_key(&current) != path_identity_key(&absolute) {
        return Err(NativeFileSystemError::PathChanged(absolute));
    }
    let current_parent = Handle::from_path(parent)
        .map_err(|source| io_error("recheck workspace parent identity", parent, source))?;
    let target_unchanged = regular_file_identity(&absolute)? == before;
    if current_parent != parent_identity || !target_unchanged {
        return Err(NativeFileSystemError::PathChanged(absolute));
    }
    drop(before);

    let persisted = temporary
        .persist(&absolute)
        .map_err(|error| io_error("atomically replace workspace file", &absolute, error.error))?;
    persisted
        .sync_all()
        .map_err(|source| io_error("sync workspace target", &absolute, source))?;
    let metadata = fs::symlink_metadata(&absolute)
        .map_err(|source| io_error("verify workspace target", &absolute, source))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(NativeFileSystemError::UnsafeFileType(absolute));
    }
    revalidate_path(authority, path)?;
    sync_parent_directory(parent, &absolute)
}

fn ensure_parent_directories(
    authority: &WorkspaceAuthority,
    path: &SafeWorkspacePath,
) -> Result<(), NativeFileSystemError> {
    if path.root() != &authority.root {
        return Err(NativeFileSystemError::AuthorityMismatch(
            path.absolute_path(),
        ));
    }
    ensure_root_stable(authority)?;
    let mut current = authority.root.as_path().to_path_buf();
    let Some(relative_parent) = path.relative_path().parent() else {
        return Ok(());
    };
    for component in relative_parent.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(NativeFileSystemError::UnsafeFileType(current));
            }
            Ok(_) => {}
            Err(source) if source.kind() == io::ErrorKind::NotFound => {
                match fs::create_dir(&current) {
                    Ok(()) => {}
                    Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(source) => {
                        return Err(io_error("create workspace directory", &current, source));
                    }
                }
                let metadata = fs::symlink_metadata(&current).map_err(|source| {
                    io_error("verify created workspace directory", &current, source)
                })?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(NativeFileSystemError::UnsafeFileType(current));
                }
            }
            Err(source) => {
                return Err(io_error("inspect workspace directory", &current, source));
            }
        }
        let canonical = dunce::canonicalize(&current)
            .map_err(|source| io_error("canonicalize workspace directory", &current, source))?;
        SafeWorkspacePath::from_canonical(&authority.root, &canonical)?;
    }
    Ok(())
}

fn regular_file_identity(path: &Path) -> Result<Option<Handle>, NativeFileSystemError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(NativeFileSystemError::UnsafeFileType(path.to_path_buf()))
        }
        Ok(_) => Handle::from_path(path)
            .map(Some)
            .map_err(|source| io_error("open workspace target identity", path, source)),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(io_error("inspect workspace target identity", path, source)),
    }
}

fn path_identity_key(path: &Path) -> String {
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

fn io_error(operation: &'static str, path: &Path, source: io::Error) -> NativeFileSystemError {
    NativeFileSystemError::Io {
        operation,
        path: path.to_path_buf(),
        source,
    }
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path, target: &Path) -> Result<(), NativeFileSystemError> {
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| io_error("sync workspace parent directory", target, source))
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path, _target: &Path) -> Result<(), NativeFileSystemError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{fs, io, path::Path};

    use codez_core::{AppErrorKind, FileKind, FileSystem};

    use super::{NativeFileSystem, NativeFileSystemError};

    #[tokio::test]
    async fn resolves_reads_and_atomically_writes_only_below_the_workspace() {
        let workspace = tempfile::tempdir().expect("temporary workspace must be available");
        fs::create_dir_all(workspace.path().join("src"))
            .expect("fixture source directory must be created");
        fs::write(workspace.path().join("src/main.rs"), "fn main() {}\n")
            .expect("fixture source must be written");
        let filesystem = NativeFileSystem::open(workspace.path().to_path_buf())
            .await
            .expect("workspace must open");
        let source = filesystem
            .resolve("src/./main.rs".into())
            .await
            .expect("in-workspace source must resolve");

        assert_eq!(
            filesystem
                .metadata(&source)
                .await
                .expect("source metadata must be readable")
                .kind,
            FileKind::File
        );
        assert_eq!(
            filesystem
                .read_bounded(&source, 1024)
                .await
                .expect("bounded source read must succeed"),
            b"fn main() {}\n"
        );
        #[cfg(windows)]
        {
            let uppercase = source
                .absolute_path()
                .to_string_lossy()
                .to_uppercase()
                .into();
            let case_variant = filesystem
                .resolve(uppercase)
                .await
                .expect("Windows case variants must resolve physically");
            assert_eq!(source.identity_key(), case_variant.identity_key());
        }
        assert_eq!(
            filesystem
                .read_bounded(&source, 4)
                .await
                .expect_err("oversized source must be rejected")
                .kind(),
            AppErrorKind::Validation
        );

        let generated = filesystem
            .resolve("generated/nested/output.txt".into())
            .await
            .expect("missing in-workspace target must resolve");
        filesystem
            .write_atomic(&generated, b"first")
            .await
            .expect("new nested workspace file must be written");
        filesystem
            .write_atomic(&generated, b"second")
            .await
            .expect("existing workspace file must be atomically replaced");
        assert_eq!(
            filesystem
                .read_bounded(&generated, 32)
                .await
                .expect("generated file must be readable"),
            b"second"
        );
    }

    #[tokio::test]
    async fn rejects_symlink_escape_and_post_validation_redirection() {
        let workspace = tempfile::tempdir().expect("temporary workspace must be available");
        let outside = tempfile::tempdir().expect("temporary outside directory must be available");
        fs::write(outside.path().join("secret.txt"), "outside")
            .expect("outside fixture must be written");
        let link = workspace.path().join("link");
        if let Err(source) = create_directory_symlink(outside.path(), &link) {
            if symlink_permission_unavailable(&source) {
                return;
            }
            panic!("fixture symlink must be created: {source}");
        }
        let filesystem = NativeFileSystem::open(workspace.path().to_path_buf())
            .await
            .expect("workspace must open");
        let escape = filesystem.resolve("link/secret.txt".into()).await;
        assert!(matches!(
            escape,
            Err(NativeFileSystemError::WorkspacePath(
                codez_core::WorkspacePathError::OutsideWorkspace(_)
            ))
        ));

        fs::remove_dir(&link).expect("fixture symlink must be removed");
        fs::create_dir(&link).expect("fixture safe directory must be created");
        fs::write(link.join("secret.txt"), "inside").expect("inside fixture must be written");
        let validated = filesystem
            .resolve("link/secret.txt".into())
            .await
            .expect("safe path must initially resolve");
        fs::remove_file(link.join("secret.txt")).expect("inside fixture must be removed");
        fs::remove_dir(&link).expect("safe fixture directory must be removed");
        create_directory_symlink(outside.path(), &link)
            .expect("second fixture symlink must be created");

        let error = filesystem
            .read_bounded(&validated, 32)
            .await
            .expect_err("post-validation redirect must be rejected");
        assert!(matches!(
            error.kind(),
            AppErrorKind::PermissionDenied | AppErrorKind::Conflict
        ));
    }

    #[cfg(unix)]
    fn create_directory_symlink(target: &Path, link: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_directory_symlink(target: &Path, link: &Path) -> io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    fn symlink_permission_unavailable(source: &io::Error) -> bool {
        source.kind() == io::ErrorKind::PermissionDenied || source.raw_os_error() == Some(1314)
    }
}
