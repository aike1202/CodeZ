use std::{
    fs, io,
    path::{Path, PathBuf},
};

use codez_core::{AppError, SafeWorkspacePath, WorkspaceRoot};
use dashmap::DashMap;
use file_id::FileId;
use thiserror::Error;

#[derive(Debug, Clone)]
struct WorkspaceAuthority {
    requested_root: PathBuf,
    root: WorkspaceRoot,
    identity: FileId,
}

#[derive(Debug, Clone)]
struct TrustedWorkingDirectory {
    path: PathBuf,
    identity: FileId,
}

#[derive(Debug, Error)]
enum WorkspaceAuthorityError {
    #[error("shell workspace root must be an absolute directory: {0}")]
    InvalidRoot(PathBuf),
    #[error("shell workspace root changed after it was authorized: {0}")]
    RootChanged(PathBuf),
    #[error("shell workspace path is outside the authorized root: {0}")]
    OutsideAuthority(PathBuf),
    #[error("shell workspace directory is a symbolic link or reparse point: {0}")]
    UnsafeDirectory(PathBuf),
    #[error("shell workspace directory identity changed: {0}")]
    DirectoryChanged(PathBuf),
    #[error("shell workspace failed to {operation}: {path}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

impl WorkspaceAuthorityError {
    fn into_app_error(self) -> AppError {
        match self {
            Self::InvalidRoot(_) => AppError::validation(self.to_string()),
            Self::OutsideAuthority(_) | Self::UnsafeDirectory(_) => {
                AppError::permission_denied(self.to_string())
            }
            Self::RootChanged(_) | Self::DirectoryChanged(_) => {
                AppError::conflict(self.to_string())
            }
            Self::Io { ref source, .. } if source.kind() == io::ErrorKind::NotFound => {
                AppError::conflict(self.to_string())
            }
            Self::Io { ref source, .. } if source.kind() == io::ErrorKind::PermissionDenied => {
                AppError::permission_denied(self.to_string())
            }
            Self::Io { .. } => AppError::external(
                "The shell workspace could not be verified",
                self.to_string(),
                false,
            ),
        }
    }
}

impl From<WorkspaceAuthorityError> for AppError {
    fn from(value: WorkspaceAuthorityError) -> Self {
        value.into_app_error()
    }
}

pub(super) struct ShellWorkspaceState {
    session_authorities: DashMap<String, WorkspaceAuthority>,
    session_working_directories: DashMap<String, TrustedWorkingDirectory>,
}

impl ShellWorkspaceState {
    pub(super) fn new() -> Self {
        Self {
            session_authorities: DashMap::new(),
            session_working_directories: DashMap::new(),
        }
    }

    pub(super) fn current_directory(
        &self,
        session_id: &str,
        requested_root: &Path,
    ) -> Result<PathBuf, AppError> {
        let authority = self.session_authority(session_id, requested_root)?;
        let remembered = self
            .session_working_directories
            .get(session_id)
            .map(|entry| entry.value().clone());
        let Some(remembered) = remembered else {
            authority.verify_root()?;
            return Ok(authority.root.as_path().to_path_buf());
        };
        if remembered.verify(&authority).is_ok() {
            return Ok(remembered.path);
        }

        self.session_working_directories.remove(session_id);
        authority.verify_root()?;
        Ok(authority.root.as_path().to_path_buf())
    }

    pub(super) fn remember_working_directory(
        &self,
        session_id: &str,
        requested_root: &Path,
        current_directory: &Path,
        requested: &Path,
    ) -> Result<(), AppError> {
        let authority = self.session_authority(session_id, requested_root)?;
        self.verify_current_directory(session_id, &authority, current_directory)?;
        let candidate = if requested.is_absolute() {
            requested.to_path_buf()
        } else {
            current_directory.join(requested)
        };
        let trusted = TrustedWorkingDirectory::open(&authority, &candidate)?;
        self.session_working_directories
            .insert(session_id.to_string(), trusted);
        Ok(())
    }

    fn verify_current_directory(
        &self,
        session_id: &str,
        authority: &WorkspaceAuthority,
        current_directory: &Path,
    ) -> Result<(), WorkspaceAuthorityError> {
        let remembered = self
            .session_working_directories
            .get(session_id)
            .map(|entry| entry.value().clone());
        if let Some(remembered) = remembered {
            remembered.verify(authority)?;
            if path_identity_key(&remembered.path) == path_identity_key(current_directory) {
                return Ok(());
            }
            return Err(WorkspaceAuthorityError::DirectoryChanged(
                current_directory.to_path_buf(),
            ));
        }

        authority.verify_root()?;
        if path_identity_key(authority.root.as_path()) == path_identity_key(current_directory) {
            Ok(())
        } else {
            Err(WorkspaceAuthorityError::DirectoryChanged(
                current_directory.to_path_buf(),
            ))
        }
    }

    pub(super) fn clear_session(&self, session_id: &str) {
        self.session_authorities.remove(session_id);
        self.session_working_directories.remove(session_id);
    }

    fn session_authority(
        &self,
        session_id: &str,
        requested_root: &Path,
    ) -> Result<WorkspaceAuthority, AppError> {
        if let Some(existing) = self.session_authorities.get(session_id) {
            let authority = existing.value().clone();
            drop(existing);
            authority.verify_context(requested_root)?;
            return Ok(authority);
        }

        let candidate = WorkspaceAuthority::open(requested_root)?;
        let authority = self
            .session_authorities
            .entry(session_id.to_string())
            .or_insert(candidate)
            .value()
            .clone();
        authority.verify_context(requested_root)?;
        Ok(authority)
    }
}

impl WorkspaceAuthority {
    fn open(requested_root: &Path) -> Result<Self, WorkspaceAuthorityError> {
        if !requested_root.is_absolute() {
            return Err(WorkspaceAuthorityError::InvalidRoot(
                requested_root.to_path_buf(),
            ));
        }
        let requested_root = requested_root.to_path_buf();
        ensure_safe_directory(&requested_root)?;
        let canonical = canonicalize_directory(&requested_root)?;
        ensure_safe_directory(&canonical)?;
        let identity = directory_identity(&canonical)?;
        let root = WorkspaceRoot::from_canonical(canonical)
            .map_err(|_| WorkspaceAuthorityError::InvalidRoot(requested_root.clone()))?;
        let authority = Self {
            requested_root,
            root,
            identity,
        };
        authority.verify_root()?;
        Ok(authority)
    }

    fn verify_context(&self, requested_root: &Path) -> Result<(), WorkspaceAuthorityError> {
        if !requested_root.is_absolute()
            || path_identity_key(requested_root) != path_identity_key(&self.requested_root)
        {
            return Err(WorkspaceAuthorityError::RootChanged(
                requested_root.to_path_buf(),
            ));
        }
        self.verify_root()
    }

    fn verify_root(&self) -> Result<(), WorkspaceAuthorityError> {
        ensure_safe_directory(&self.requested_root)?;
        let canonical = canonicalize_directory(&self.requested_root)?;
        ensure_safe_directory(&self.requested_root)?;
        ensure_safe_directory(&canonical)?;
        let identity = directory_identity(&canonical)?;
        if path_identity_key(&canonical) != path_identity_key(self.root.as_path())
            || identity != self.identity
        {
            return Err(WorkspaceAuthorityError::RootChanged(
                self.requested_root.clone(),
            ));
        }
        Ok(())
    }
}

impl TrustedWorkingDirectory {
    fn open(
        authority: &WorkspaceAuthority,
        requested: &Path,
    ) -> Result<Self, WorkspaceAuthorityError> {
        authority.verify_root()?;
        let inspected = inspect_directory_components(authority, requested)?;
        let canonical = canonicalize_directory(&inspected)?;
        SafeWorkspacePath::from_canonical(&authority.root, &canonical)
            .map_err(|_| WorkspaceAuthorityError::OutsideAuthority(canonical.clone()))?;
        if path_identity_key(&canonical) != path_identity_key(&inspected) {
            return Err(WorkspaceAuthorityError::UnsafeDirectory(inspected));
        }
        ensure_safe_directory(&canonical)?;
        let identity = directory_identity(&canonical)?;
        authority.verify_root()?;
        let trusted = Self {
            path: canonical,
            identity,
        };
        trusted.verify(authority)?;
        Ok(trusted)
    }

    fn verify(&self, authority: &WorkspaceAuthority) -> Result<(), WorkspaceAuthorityError> {
        authority.verify_root()?;
        let inspected = inspect_directory_components(authority, &self.path)?;
        let canonical = canonicalize_directory(&inspected)?;
        SafeWorkspacePath::from_canonical(&authority.root, &canonical)
            .map_err(|_| WorkspaceAuthorityError::OutsideAuthority(canonical.clone()))?;
        let identity = directory_identity(&canonical)?;
        if path_identity_key(&canonical) != path_identity_key(&self.path)
            || identity != self.identity
        {
            return Err(WorkspaceAuthorityError::DirectoryChanged(self.path.clone()));
        }
        ensure_safe_directory(&self.path)?;
        authority.verify_root()?;
        Ok(())
    }
}

fn inspect_directory_components(
    authority: &WorkspaceAuthority,
    requested: &Path,
) -> Result<PathBuf, WorkspaceAuthorityError> {
    let relative = requested
        .strip_prefix(authority.root.as_path())
        .map_err(|_| WorkspaceAuthorityError::OutsideAuthority(requested.to_path_buf()))?;
    let mut current = authority.root.as_path().to_path_buf();
    for component in relative.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::Normal(part) => {
                current.push(part);
                ensure_safe_directory(&current)?;
            }
            std::path::Component::ParentDir => {
                if current == authority.root.as_path() || !current.pop() {
                    return Err(WorkspaceAuthorityError::OutsideAuthority(
                        requested.to_path_buf(),
                    ));
                }
            }
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                return Err(WorkspaceAuthorityError::OutsideAuthority(
                    requested.to_path_buf(),
                ));
            }
        }
    }
    ensure_safe_directory(&current)?;
    Ok(current)
}

fn ensure_safe_directory(path: &Path) -> Result<(), WorkspaceAuthorityError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|source| workspace_io("inspect directory metadata", path, source))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() || is_reparse_point(&metadata) {
        return Err(WorkspaceAuthorityError::UnsafeDirectory(path.to_path_buf()));
    }
    Ok(())
}

fn canonicalize_directory(path: &Path) -> Result<PathBuf, WorkspaceAuthorityError> {
    dunce::canonicalize(path).map_err(|source| workspace_io("canonicalize directory", path, source))
}

fn directory_identity(path: &Path) -> Result<FileId, WorkspaceAuthorityError> {
    file_id::get_file_id(path)
        .map_err(|source| workspace_io("read directory identity", path, source))
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

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
const fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn workspace_io(
    operation: &'static str,
    path: &Path,
    source: io::Error,
) -> WorkspaceAuthorityError {
    WorkspaceAuthorityError::Io {
        operation,
        path: path.to_path_buf(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use std::{io, path::Path};

    use codez_core::AppErrorKind;

    use super::ShellWorkspaceState;

    #[test]
    fn separate_sessions_keep_independent_workspace_authorities_and_cwds() {
        let first = tempfile::tempdir().expect("first workspace must be available");
        let second = tempfile::tempdir().expect("second workspace must be available");
        let first_nested = first.path().join("first-nested");
        let second_nested = second.path().join("second-nested");
        std::fs::create_dir(&first_nested).expect("first cwd must be created");
        std::fs::create_dir(&second_nested).expect("second cwd must be created");
        let state = ShellWorkspaceState::new();

        let first_root = state
            .current_directory("session-a", first.path())
            .expect("first root must be trusted");
        let second_root = state
            .current_directory("session-b", second.path())
            .expect("second root must be trusted");
        state
            .remember_working_directory(
                "session-a",
                first.path(),
                &first_root,
                Path::new("first-nested"),
            )
            .expect("first cwd must be trusted");
        state
            .remember_working_directory(
                "session-b",
                second.path(),
                &second_root,
                Path::new("second-nested"),
            )
            .expect("second cwd must be trusted");

        assert_eq!(
            state
                .current_directory("session-a", first.path())
                .expect("first cwd must remain trusted"),
            first_nested
        );
        assert_eq!(
            state
                .current_directory("session-b", second.path())
                .expect("second cwd must remain trusted"),
            second_nested
        );
    }

    #[test]
    fn one_session_cannot_switch_to_another_workspace_root() {
        let first = tempfile::tempdir().expect("first workspace must be available");
        let second = tempfile::tempdir().expect("second workspace must be available");
        let state = ShellWorkspaceState::new();
        state
            .current_directory("session", first.path())
            .expect("initial root must be trusted");

        let error = state
            .current_directory("session", second.path())
            .expect_err("replacement root must be rejected");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
    }

    #[test]
    fn recreated_root_is_rejected_by_stable_identity() {
        let parent = tempfile::tempdir().expect("workspace parent must be available");
        let root = parent.path().join("workspace");
        let replaced = parent.path().join("replaced");
        std::fs::create_dir(&root).expect("workspace must be created");
        let state = ShellWorkspaceState::new();
        state
            .current_directory("session", &root)
            .expect("initial root must be trusted");
        std::fs::rename(&root, replaced).expect("initial root must be moved");
        std::fs::create_dir(&root).expect("replacement root must be created");

        let error = state
            .current_directory("session", &root)
            .expect_err("replacement root must be rejected");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
    }

    #[test]
    fn recreated_cwd_falls_back_to_the_still_trusted_root() {
        let root = tempfile::tempdir().expect("workspace must be available");
        let nested = root.path().join("nested");
        let replaced = root.path().join("replaced");
        std::fs::create_dir(&nested).expect("nested cwd must be created");
        let state = ShellWorkspaceState::new();
        let initial = state
            .current_directory("session", root.path())
            .expect("initial root must be trusted");
        state
            .remember_working_directory("session", root.path(), &initial, Path::new("nested"))
            .expect("nested cwd must be trusted");
        std::fs::rename(&nested, replaced).expect("nested cwd must be moved");
        std::fs::create_dir(&nested).expect("replacement cwd must be created");

        let current = state
            .current_directory("session", root.path())
            .expect("trusted root must remain usable");

        assert_eq!(current, root.path());
    }

    #[test]
    fn link_replacements_are_rejected_or_fall_back_when_supported() {
        let parent = tempfile::tempdir().expect("workspace parent must be available");
        let outside = tempfile::tempdir().expect("outside directory must be available");
        let root = parent.path().join("workspace");
        let root_backup = parent.path().join("workspace-backup");
        let nested = root.join("nested");
        let nested_backup = root.join("nested-backup");
        std::fs::create_dir_all(&nested).expect("workspace tree must be created");
        let state = ShellWorkspaceState::new();
        let initial = state
            .current_directory("session", &root)
            .expect("initial root must be trusted");
        state
            .remember_working_directory("session", &root, &initial, Path::new("nested"))
            .expect("nested cwd must be trusted");
        std::fs::rename(&nested, &nested_backup).expect("nested cwd must be moved");
        if let Err(source) = create_directory_link(outside.path(), &nested) {
            if link_permission_unavailable(&source) {
                return;
            }
            panic!("cwd replacement link must be created: {source}");
        }
        let fallback = state
            .current_directory("session", &root)
            .expect("unsafe cwd must fall back while root is trusted");
        assert_eq!(fallback, root);

        std::fs::remove_dir(&nested).expect("cwd link must be removed");
        std::fs::rename(&root, &root_backup).expect("root must be moved");
        if let Err(source) = create_directory_link(outside.path(), &root) {
            if link_permission_unavailable(&source) {
                return;
            }
            panic!("root replacement link must be created: {source}");
        }

        let error = state
            .current_directory("session", &root)
            .expect_err("unsafe root replacement must be rejected");
        assert_eq!(error.kind(), AppErrorKind::PermissionDenied);
    }

    #[test]
    fn clear_session_removes_both_authority_and_cwd() {
        let first = tempfile::tempdir().expect("first workspace must be available");
        let second = tempfile::tempdir().expect("second workspace must be available");
        let nested = first.path().join("nested");
        std::fs::create_dir(&nested).expect("nested cwd must be created");
        let state = ShellWorkspaceState::new();
        let initial = state
            .current_directory("session", first.path())
            .expect("initial root must be trusted");
        state
            .remember_working_directory("session", first.path(), &initial, Path::new("nested"))
            .expect("nested cwd must be trusted");

        state.clear_session("session");

        assert_eq!(
            state
                .current_directory("session", second.path())
                .expect("cleared session must accept a fresh root"),
            second.path()
        );
    }

    #[cfg(unix)]
    fn create_directory_link(target: &Path, link: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_directory_link(target: &Path, link: &Path) -> io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    fn link_permission_unavailable(source: &io::Error) -> bool {
        source.kind() == io::ErrorKind::PermissionDenied || source.raw_os_error() == Some(1314)
    }
}
