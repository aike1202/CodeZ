use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedToolPath {
    pub path: PathBuf,
    pub inside_workspace: bool,
}

#[derive(Debug, Error)]
pub enum ToolPathError {
    #[error("the tool path is empty")]
    Empty,
    #[error("the workspace root is not a canonical directory")]
    InvalidWorkspace,
    #[error("the tool path cannot be resolved")]
    InvalidPath,
    #[error("the tool path changed after authorization")]
    AuthorizationMismatch,
}

pub async fn resolve_tool_path(
    input_path: &str,
    workspace_root: &Path,
) -> Result<ResolvedToolPath, ToolPathError> {
    if input_path.trim().is_empty() {
        return Err(ToolPathError::Empty);
    }
    if !workspace_root.is_absolute() || !workspace_root.is_dir() {
        return Err(ToolPathError::InvalidWorkspace);
    }
    let joined = if Path::new(input_path).is_absolute() {
        PathBuf::from(input_path)
    } else {
        workspace_root.join(input_path)
    };
    let normalized = lexical_normalize(&joined)?;
    let (existing_parent, suffix) = nearest_existing_parent(&normalized).await?;
    let canonical_parent = tokio::fs::canonicalize(existing_parent)
        .await
        .map_err(|_| ToolPathError::InvalidPath)?;
    let mut resolved = canonical_parent;
    for component in suffix {
        resolved.push(component);
    }
    let inside_workspace = resolved.starts_with(workspace_root);
    Ok(ResolvedToolPath {
        path: resolved,
        inside_workspace,
    })
}

async fn nearest_existing_parent(path: &Path) -> Result<(PathBuf, Vec<OsString>), ToolPathError> {
    let mut current = path.to_path_buf();
    let mut suffix = Vec::new();
    loop {
        match tokio::fs::symlink_metadata(&current).await {
            Ok(_) => {
                suffix.reverse();
                return Ok((current, suffix));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(ToolPathError::InvalidPath),
        }
        let Some(name) = current.file_name().map(OsString::from) else {
            return Err(ToolPathError::InvalidPath);
        };
        let Some(parent) = current.parent() else {
            return Err(ToolPathError::InvalidPath);
        };
        suffix.push(name);
        current = parent.to_path_buf();
    }
}

fn lexical_normalize(path: &Path) -> Result<PathBuf, ToolPathError> {
    let mut prefix = None;
    let mut rooted = false;
    let mut parts: Vec<OsString> = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(value) => prefix = Some(value.as_os_str().to_os_string()),
            Component::RootDir => rooted = true,
            Component::CurDir => {}
            Component::ParentDir => {
                if parts.pop().is_none() && !rooted {
                    return Err(ToolPathError::InvalidPath);
                }
            }
            Component::Normal(value) => parts.push(value.to_os_string()),
        }
    }
    let mut normalized = PathBuf::new();
    if let Some(value) = prefix {
        normalized.push(value);
    }
    if rooted {
        normalized.push(Path::new(std::path::MAIN_SEPARATOR_STR));
    }
    for part in parts {
        normalized.push(part);
    }
    if normalized.is_absolute() {
        Ok(normalized)
    } else {
        Err(ToolPathError::InvalidPath)
    }
}
