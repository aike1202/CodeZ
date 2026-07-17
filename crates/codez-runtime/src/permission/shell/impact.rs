use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use tokio::fs;

static SENSITIVE_PATTERN: LazyLock<Result<Regex, regex::Error>> = LazyLock::new(|| {
    Regex::new(
        r#"/(?:\.ssh|\.aws)(?:/|$)|\/(?:etc|private/etc)(?:/|$)|\/(?:\.bashrc|\.zshrc|\.profile)$|\/(?:\.npmrc|\.pypirc|\.netrc)$|/codez/(?:permission-rules|workspace-permissions)\.json$"#,
    )
});

pub struct PathImpactResult {
    pub input_path: String,
    pub resolved_path: String,
    pub real_parent_path: String,
    pub inside_workspace: bool,
    pub sensitive: bool,
}

async fn nearest_existing_parent(target: &Path) -> (PathBuf, Vec<String>) {
    let mut suffix = Vec::new();
    let mut current = target.to_path_buf();

    loop {
        if fs::symlink_metadata(&current).await.is_ok() {
            suffix.reverse();
            return (current, suffix);
        }
        if let Some(parent) = current.parent() {
            if parent == current {
                suffix.reverse();
                return (current, suffix);
            }
            if let Some(name) = current.file_name() {
                suffix.push(name.to_string_lossy().to_string());
            }
            current = parent.to_path_buf();
        } else {
            suffix.reverse();
            return (current, suffix);
        }
    }
}

pub struct PathImpactAnalyzer;

impl PathImpactAnalyzer {
    pub async fn analyze(input_path: &str, workspace_root: &str, cwd: &str) -> PathImpactResult {
        let input = Path::new(input_path);
        let resolved_path = if input.is_absolute() {
            input.to_path_buf()
        } else {
            Path::new(cwd).join(input)
        };

        let (nearest_parent, suffix) = nearest_existing_parent(&resolved_path).await;

        let real_parent_path = match fs::canonicalize(&nearest_parent).await {
            Ok(p) => p,
            Err(_) => nearest_parent.clone(),
        };

        let mut canonical_target = real_parent_path.clone();
        for comp in suffix {
            canonical_target.push(comp);
        }

        let real_root = match fs::canonicalize(Path::new(workspace_root)).await {
            Ok(p) => p,
            Err(_) => Path::new(workspace_root).to_path_buf(),
        };

        let inside_workspace = canonical_target.starts_with(&real_root);

        let normalized = canonical_target
            .to_string_lossy()
            .replace("\\", "/")
            .to_lowercase();
        let sensitive = SENSITIVE_PATTERN
            .as_ref()
            .is_ok_and(|pattern| pattern.is_match(&normalized));

        PathImpactResult {
            input_path: input_path.to_string(),
            resolved_path: canonical_target.to_string_lossy().to_string(),
            real_parent_path: real_parent_path.to_string_lossy().to_string(),
            inside_workspace,
            sensitive,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::path::Path;

    use super::PathImpactAnalyzer;

    #[cfg(unix)]
    fn symlink_file(target: &Path, link: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn symlink_file(target: &Path, link: &Path) -> io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }

    #[tokio::test]
    async fn symlink_target_outside_workspace_is_external() {
        let workspace = tempfile::tempdir().expect("workspace must exist");
        let external = tempfile::tempdir().expect("external directory must exist");
        let external_file = external.path().join("outside.txt");
        std::fs::write(&external_file, "outside").expect("external fixture must be written");
        let link = workspace.path().join("linked.txt");
        if let Err(error) = symlink_file(&external_file, &link) {
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
            return;
        }

        let impact = PathImpactAnalyzer::analyze(
            &link.to_string_lossy(),
            &workspace.path().to_string_lossy(),
            &workspace.path().to_string_lossy(),
        )
        .await;
        assert!(!impact.inside_workspace);
    }

    #[tokio::test]
    async fn sensitive_path_inside_workspace_is_still_sensitive() {
        let workspace = tempfile::tempdir().expect("workspace must exist");
        let target = workspace.path().join(".ssh").join("config");
        let impact = PathImpactAnalyzer::analyze(
            &target.to_string_lossy(),
            &workspace.path().to_string_lossy(),
            &workspace.path().to_string_lossy(),
        )
        .await;
        assert!(impact.inside_workspace && impact.sensitive);
    }
}
