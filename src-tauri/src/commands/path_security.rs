use std::{
    io,
    path::{Component, Path, PathBuf},
};

use codez_core::{AppError, RecentProject, SafeWorkspacePath, WorkspaceRoot};
use thiserror::Error;

const MAX_FILE_NAME_BYTES: usize = 160;
const MAX_WORKSPACE_PATH_BYTES: usize = 32_768;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct SafeFileName(String);

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub(super) enum SafeFileNameError {
    #[error("file name cannot be empty")]
    Empty,
    #[error("file name exceeds the {MAX_FILE_NAME_BYTES}-byte limit")]
    TooLong,
    #[error("file name must be one portable filesystem segment")]
    UnsafeSegment,
    #[error("file name uses a reserved Windows device name")]
    ReservedWindowsName,
}

impl SafeFileName {
    pub(super) fn parse(value: impl Into<String>) -> Result<Self, SafeFileNameError> {
        let value = value.into();
        if value.is_empty() {
            return Err(SafeFileNameError::Empty);
        }
        if value.len() > MAX_FILE_NAME_BYTES {
            return Err(SafeFileNameError::TooLong);
        }
        if value.trim() != value
            || value == "."
            || value.contains("..")
            || value.ends_with('.')
            || value.chars().any(is_forbidden_file_name_character)
        {
            return Err(SafeFileNameError::UnsafeSegment);
        }
        if is_reserved_windows_name(&value) {
            return Err(SafeFileNameError::ReservedWindowsName);
        }
        Ok(Self(value))
    }

    pub(super) fn as_str(&self) -> &str {
        &self.0
    }
}

pub(super) async fn authorize_workspace(
    requested_root: &str,
    expected_project_id: Option<&str>,
    registered_projects: &[RecentProject],
) -> Result<WorkspaceRoot, AppError> {
    if requested_root.len() > MAX_WORKSPACE_PATH_BYTES {
        return Err(AppError::validation("Workspace path is too long"));
    }
    let requested = PathBuf::from(requested_root);
    if !requested.is_absolute()
        || requested
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(AppError::validation(
            "Workspace path must be an absolute normalized path",
        ));
    }

    let metadata = tokio::fs::symlink_metadata(&requested)
        .await
        .map_err(|source| path_io_error("inspect workspace", &requested, source))?;
    if metadata_is_link_or_reparse(&metadata) {
        return Err(AppError::permission_denied(
            "Workspace roots must not be symbolic links or reparse points",
        ));
    }
    if !metadata.is_dir() {
        return Err(AppError::validation("Workspace root must be a directory"));
    }

    let canonical_request = requested.clone();
    let canonical = tokio::task::spawn_blocking(move || dunce::canonicalize(&canonical_request))
        .await
        .map_err(|source| {
            AppError::internal(format!(
                "workspace canonicalization worker failed: {source}"
            ))
        })?
        .map_err(|source| path_io_error("canonicalize workspace", &requested, source))?;
    let root = WorkspaceRoot::from_canonical(canonical)
        .map_err(|source| AppError::validation(source.to_string()))?;
    let registered = registered_projects.iter().find(|project| {
        project.root().identity_key() == root.identity_key()
            && expected_project_id.is_none_or(|id| project.id() == id)
    });
    if registered.is_none() {
        return Err(AppError::permission_denied(
            "Workspace has not been authorized by the user",
        ));
    }
    Ok(root)
}

pub(super) fn workspace_path(
    root: &WorkspaceRoot,
    relative_path: &Path,
) -> Result<PathBuf, AppError> {
    SafeWorkspacePath::from_relative(root, relative_path)
        .map(|path| path.absolute_path())
        .map_err(|source| AppError::validation(source.to_string()))
}

pub(super) fn parse_untrusted_absolute_path(value: &str) -> Result<PathBuf, AppError> {
    if value.len() > MAX_WORKSPACE_PATH_BYTES {
        return Err(AppError::validation("File path is too long"));
    }
    if value.is_empty() || value.trim() != value {
        return Err(AppError::validation(
            "File path must not be empty or padded with whitespace",
        ));
    }
    let path = PathBuf::from(value);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(AppError::validation(
            "File path must be an absolute normalized path",
        ));
    }
    validate_portable_absolute_path(&path)?;
    Ok(path)
}

pub(super) async fn ensure_secure_path(
    authority_root: &Path,
    target: &Path,
) -> Result<(), AppError> {
    if !authority_root.is_absolute() || target.strip_prefix(authority_root).is_err() {
        return Err(AppError::permission_denied(
            "File path is outside its authorized root",
        ));
    }

    let authority_metadata = tokio::fs::symlink_metadata(authority_root)
        .await
        .map_err(|source| path_io_error("inspect authorized root", authority_root, source))?;
    if metadata_is_link_or_reparse(&authority_metadata) {
        return Err(AppError::permission_denied(
            "Authorized roots must not be symbolic links or reparse points",
        ));
    }
    if !authority_metadata.is_dir() {
        return Err(AppError::storage(
            "The local data operation failed",
            format!(
                "authorized root is not a directory: {}",
                authority_root.display()
            ),
            false,
        ));
    }

    let relative = target
        .strip_prefix(authority_root)
        .map_err(|_| AppError::permission_denied("File path is outside its authorized root"))?;
    let components: Vec<_> = relative.components().collect();
    let mut current = authority_root.to_path_buf();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(segment) = component else {
            return Err(AppError::validation(
                "Authorized file path contains an invalid component",
            ));
        };
        current.push(segment);
        match tokio::fs::symlink_metadata(&current).await {
            Ok(metadata) if metadata_is_link_or_reparse(&metadata) => {
                return Err(AppError::permission_denied(
                    "Links and reparse points are not allowed in writable application paths",
                ));
            }
            Ok(metadata) if index + 1 < components.len() && !metadata.is_dir() => {
                return Err(AppError::storage(
                    "The local data operation failed",
                    format!("path ancestor is not a directory: {}", current.display()),
                    false,
                ));
            }
            Ok(_) => {}
            Err(source) if source.kind() == io::ErrorKind::NotFound => break,
            Err(source) => {
                return Err(path_io_error("inspect path component", &current, source));
            }
        }
    }
    Ok(())
}

pub(super) async fn secure_directory_exists(
    authority_root: &Path,
    directory: &Path,
) -> Result<bool, AppError> {
    ensure_secure_path(authority_root, directory).await?;
    match tokio::fs::symlink_metadata(directory).await {
        Ok(metadata) if metadata_is_link_or_reparse(&metadata) => Err(AppError::permission_denied(
            "Links and reparse points are not allowed in application data directories",
        )),
        Ok(metadata) if metadata.is_dir() => Ok(true),
        Ok(_) => Err(AppError::storage(
            "The local data operation failed",
            format!("expected a directory: {}", directory.display()),
            false,
        )),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(path_io_error("inspect directory", directory, source)),
    }
}

pub(super) fn paths_equal(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy().replace('/', "\\").to_lowercase()
            == right.to_string_lossy().replace('/', "\\").to_lowercase()
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

pub(super) fn path_io_error(operation: &'static str, path: &Path, source: io::Error) -> AppError {
    let public_message = if source.kind() == io::ErrorKind::NotFound {
        "The requested local path was not found"
    } else {
        "The local data operation failed"
    };
    AppError::storage(
        public_message,
        format!("{operation}: {}: {source}", path.display()),
        false,
    )
}

pub(super) fn metadata_is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    false
}

fn validate_portable_absolute_path(path: &Path) -> Result<(), AppError> {
    #[cfg(windows)]
    validate_windows_path_prefix(path)?;

    for component in path.components() {
        if let Component::Normal(segment) = component {
            let value = segment.to_str().ok_or_else(|| {
                AppError::validation("File path components must be valid Unicode")
            })?;
            SafeFileName::parse(value.to_string())
                .map_err(|source| AppError::validation(source.to_string()))?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn validate_windows_path_prefix(path: &Path) -> Result<(), AppError> {
    use std::path::Prefix;

    let supported = matches!(
        path.components().next(),
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_))
    );
    if supported {
        Ok(())
    } else {
        Err(AppError::validation(
            "UNC, device, and verbatim file paths are not allowed",
        ))
    }
}

fn is_forbidden_file_name_character(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
        )
}

fn is_reserved_windows_name(value: &str) -> bool {
    let stem = value.split('.').next().unwrap_or(value);
    let uppercase = stem.to_ascii_uppercase();
    matches!(
        uppercase.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
    ) || uppercase
        .strip_prefix("COM")
        .or_else(|| uppercase.strip_prefix("LPT"))
        .is_some_and(|suffix| matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use codez_core::{AppErrorKind, RecentProject, WorkspaceRoot};

    use super::{SafeFileName, authorize_workspace};

    #[cfg(unix)]
    use super::ensure_secure_path;

    #[test]
    fn safe_file_name_accepts_portable_unicode() {
        let parsed = SafeFileName::parse("规则-审查.zh-CN.md")
            .expect("portable Unicode fixture must be valid");

        assert_eq!(parsed.as_str(), "规则-审查.zh-CN.md");
    }

    #[test]
    fn safe_file_name_rejects_traversal_and_absolute_forms() {
        let candidates = [
            "../escape.md",
            r"..\escape.md",
            "/tmp/rule.md",
            r"C:\rule.md",
        ];

        assert!(
            candidates
                .into_iter()
                .all(|candidate| SafeFileName::parse(candidate).is_err())
        );
    }

    #[test]
    fn safe_file_name_rejects_windows_unc_ads_and_device_names() {
        let candidates = [r"\\server\share", "rule.md:secret", "CON", "lpt9.md"];

        assert!(
            candidates
                .into_iter()
                .all(|candidate| SafeFileName::parse(candidate).is_err())
        );
    }

    #[tokio::test]
    async fn workspace_authorization_rejects_unregistered_roots() {
        let registered_directory = tempfile::tempdir().expect("registered root must exist");
        let other_directory = tempfile::tempdir().expect("unregistered root must exist");
        let registered_root = WorkspaceRoot::from_canonical(
            fs::canonicalize(registered_directory.path())
                .expect("registered root must canonicalize"),
        )
        .expect("fixture root must be canonical");
        let project = RecentProject::new(
            "project-1".to_string(),
            registered_root,
            "Project".to_string(),
            "rust".to_string(),
            "2026-07-16T00:00:00Z".to_string(),
        )
        .expect("fixture project must be valid");

        let error =
            authorize_workspace(&other_directory.path().to_string_lossy(), None, &[project])
                .await
                .expect_err("an unregistered root must be rejected");

        assert_eq!(error.kind(), AppErrorKind::PermissionDenied);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn secure_paths_reject_symlink_escapes() {
        use std::os::unix::fs::symlink;

        let authority = tempfile::tempdir().expect("authority root must exist");
        let outside = tempfile::tempdir().expect("outside root must exist");
        let link = authority.path().join("rules");
        symlink(outside.path(), &link).expect("fixture symlink must be created");

        let error = ensure_secure_path(authority.path(), &link.join("escape.md"))
            .await
            .expect_err("a symlink ancestor must be rejected");

        assert_eq!(error.kind(), AppErrorKind::PermissionDenied);
    }
}
