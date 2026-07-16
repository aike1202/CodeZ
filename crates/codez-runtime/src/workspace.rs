use std::{collections::VecDeque, future::Future, path::Path, pin::Pin, sync::Arc};

use codez_core::{AppError, AppErrorKind, FileKind, FileSystem, SafeWorkspacePath};

const IGNORED_DIRECTORIES: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage",
    "out",
    "__pycache__",
    ".idea",
    ".vscode",
    ".cache",
    ".turbo",
    "target",
    ".nuxt",
    ".output",
];
const IGNORED_EXTENSIONS: &[&str] = &[
    ".exe", ".dll", ".so", ".dylib", ".bin", ".obj", ".o", ".class", ".pyc", ".pyd", ".lock",
];
const BINARY_EXTENSIONS: &[&str] = &[
    ".exe", ".dll", ".so", ".dylib", ".bin", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".bmp",
    ".webp", ".svg", ".mp3", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".zip", ".tar", ".gz", ".7z",
    ".rar", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".ttf", ".otf", ".woff",
    ".woff2", ".wasm", ".node",
];

/// Resource bounds applied to workspace discovery and preview operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkspaceLimits {
    pub max_entries: usize,
    pub max_tree_depth: usize,
    pub max_file_bytes: u64,
    pub max_preview_bytes: usize,
    pub max_preview_lines: usize,
    pub max_directory_preview_entries: usize,
}

impl Default for WorkspaceLimits {
    fn default() -> Self {
        Self {
            max_entries: 50_000,
            max_tree_depth: 64,
            max_file_bytes: 5 * 1024 * 1024,
            max_preview_bytes: 1024 * 1024,
            max_preview_lines: 1_000,
            max_directory_preview_entries: 1_000,
        }
    }
}

/// Workspace tree node kind retained independently from wire spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceEntryKind {
    File,
    Directory,
}

/// Recursive workspace tree node returned by the application service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileTreeNode {
    pub name: String,
    pub path: String,
    pub kind: WorkspaceEntryKind,
    pub children: Vec<Self>,
    pub size: Option<u64>,
    pub extension: Option<String>,
}

/// Flat workspace path used by autocomplete and search scopes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspacePathItem {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
}

/// Bounded text or directory preview compatible with the legacy UI shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilePreview {
    pub path: String,
    pub content: String,
    pub truncated: bool,
    pub total_lines: usize,
}

/// Detected project language/framework metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectInfo {
    pub project_type: String,
    pub framework: Option<String>,
    pub package_manager: Option<String>,
}

/// Workspace application service depending only on the bounded filesystem port.
pub struct WorkspaceService {
    filesystem: Arc<dyn FileSystem>,
    limits: WorkspaceLimits,
}

impl std::fmt::Debug for WorkspaceService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkspaceService")
            .field("root", self.filesystem.workspace_root())
            .field("limits", &self.limits)
            .finish_non_exhaustive()
    }
}

impl WorkspaceService {
    #[must_use]
    pub fn new(filesystem: Arc<dyn FileSystem>) -> Self {
        Self::with_limits(filesystem, WorkspaceLimits::default())
    }

    #[must_use]
    pub fn with_limits(filesystem: Arc<dyn FileSystem>, limits: WorkspaceLimits) -> Self {
        Self { filesystem, limits }
    }

    /// Builds a recursive, deterministic file tree below the workspace root.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when filesystem validation fails or configured entry
    /// and depth bounds are exceeded.
    pub async fn scan_file_tree(&self) -> Result<Vec<FileTreeNode>, AppError> {
        validate_limits(self.limits)?;
        let root = self.filesystem.resolve(Path::new("")).await?;
        let mut remaining = self.limits.max_entries;
        self.scan_directory(root, 0, &mut remaining).await
    }

    /// Returns a deterministic flat list of all allowed workspace paths.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when filesystem validation fails or the entry bound
    /// is exceeded.
    pub async fn all_paths(&self) -> Result<Vec<WorkspacePathItem>, AppError> {
        validate_limits(self.limits)?;
        let root = self.filesystem.resolve(Path::new("")).await?;
        let mut queue = VecDeque::from([root]);
        let mut remaining = self.limits.max_entries;
        let mut results = Vec::new();
        while let Some(directory) = queue.pop_front() {
            let listing = self
                .filesystem
                .read_directory(&directory, remaining.saturating_add(1))
                .await?;
            if listing.truncated || listing.entries.len() > remaining {
                return Err(entry_limit_error(self.limits.max_entries));
            }
            remaining = remaining.saturating_sub(listing.entries.len());
            for entry in listing.entries {
                let Some(name) = entry.name.to_str().map(str::to_owned) else {
                    continue;
                };
                if should_ignore(&name, entry.kind) {
                    continue;
                }
                let is_directory = entry.kind == FileKind::Directory;
                if is_directory {
                    queue.push_back(entry.path.clone());
                } else if entry.kind != FileKind::File {
                    continue;
                }
                results.push(WorkspacePathItem {
                    name,
                    path: display_relative(&entry.path),
                    is_directory,
                });
            }
        }
        results.sort_by(|left, right| {
            right
                .is_directory
                .cmp(&left.is_directory)
                .then_with(|| compare_names(&left.path, &right.path))
        });
        Ok(results)
    }

    /// Reads a bounded text or directory preview for one untrusted path.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the path escapes, changes identity, disappears,
    /// or cannot be read through the bounded filesystem port.
    pub async fn read_preview(&self, requested: &Path) -> Result<FilePreview, AppError> {
        validate_limits(self.limits)?;
        let safe = self.filesystem.resolve(requested).await?;
        let metadata = self.filesystem.metadata(&safe).await?;
        let path = requested.to_string_lossy().into_owned();
        if metadata.kind == FileKind::Directory {
            return self.directory_preview(path, &safe).await;
        }
        if metadata.kind != FileKind::File {
            return Err(AppError::validation(
                "The workspace path is not a regular file",
            ));
        }
        if metadata.byte_length > self.limits.max_file_bytes {
            return Ok(FilePreview {
                path,
                content: format!(
                    "[File too large to preview] Size: {:.1} MB; limit: {:.1} MB",
                    metadata.byte_length as f64 / 1024.0 / 1024.0,
                    self.limits.max_file_bytes as f64 / 1024.0 / 1024.0,
                ),
                truncated: true,
                total_lines: 0,
            });
        }
        if is_binary_extension(safe.relative_path()) {
            return Ok(FilePreview {
                path,
                content: format!(
                    "[Binary file preview is unavailable] Type: {}",
                    extension(safe.relative_path()).unwrap_or_else(|| "unknown".to_string())
                ),
                truncated: false,
                total_lines: 0,
            });
        }
        let bytes = self
            .filesystem
            .read_bounded(&safe, self.limits.max_file_bytes)
            .await?;
        if bytes.iter().take(512).any(|byte| *byte == 0) {
            return Ok(FilePreview {
                path,
                content: "[Binary or unsupported encoding; preview is unavailable]".to_string(),
                truncated: false,
                total_lines: 0,
            });
        }
        let Ok(content) = String::from_utf8(bytes) else {
            return Ok(FilePreview {
                path,
                content: "[Binary or unsupported encoding; preview is unavailable]".to_string(),
                truncated: false,
                total_lines: 0,
            });
        };
        let total_lines = content.split('\n').count();
        let (content, truncated) = truncate_text(
            &content,
            self.limits.max_preview_bytes,
            self.limits.max_preview_lines,
        );
        Ok(FilePreview {
            path,
            content,
            truncated,
            total_lines,
        })
    }

    /// Detects the most specific known project type at the workspace root.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] for filesystem failures other than an absent marker.
    pub async fn detect_project(&self) -> Result<ProjectInfo, AppError> {
        const DETECTORS: &[(&str, &str, Option<&str>, Option<&str>)] = &[
            ("next.config.js", "nodejs", Some("next"), None),
            ("next.config.mjs", "nodejs", Some("next"), None),
            ("next.config.ts", "nodejs", Some("next"), None),
            ("vite.config.ts", "nodejs", Some("vite"), None),
            ("vite.config.js", "nodejs", Some("vite"), None),
            ("Cargo.toml", "rust", None, Some("cargo")),
            ("go.mod", "go", None, Some("go")),
            ("pom.xml", "java", Some("maven"), Some("maven")),
            ("build.gradle", "java", Some("gradle"), Some("gradle")),
            ("build.gradle.kts", "java", Some("gradle"), Some("gradle")),
            ("pyproject.toml", "python", None, None),
            ("requirements.txt", "python", None, Some("pip")),
            ("package.json", "nodejs", None, None),
        ];
        for (file, project_type, framework, package_manager) in DETECTORS {
            let path = self.filesystem.resolve(Path::new(file)).await?;
            match self.filesystem.metadata(&path).await {
                Ok(metadata) if metadata.kind == FileKind::File => {
                    let package_manager = if *project_type == "nodejs" {
                        self.detect_node_package_manager().await?
                    } else {
                        package_manager.map(str::to_string)
                    };
                    return Ok(ProjectInfo {
                        project_type: (*project_type).to_string(),
                        framework: framework.map(str::to_string),
                        package_manager,
                    });
                }
                Ok(_) => {}
                Err(error) if error.kind() == AppErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(ProjectInfo {
            project_type: "unknown".to_string(),
            framework: None,
            package_manager: None,
        })
    }

    fn scan_directory<'a>(
        &'a self,
        directory: SafeWorkspacePath,
        depth: usize,
        remaining: &'a mut usize,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<FileTreeNode>, AppError>> + Send + 'a>> {
        Box::pin(async move {
            if depth > self.limits.max_tree_depth {
                return Err(AppError::validation("Workspace tree depth limit exceeded"));
            }
            let listing = self
                .filesystem
                .read_directory(&directory, remaining.saturating_add(1))
                .await?;
            if listing.truncated || listing.entries.len() > *remaining {
                return Err(entry_limit_error(self.limits.max_entries));
            }
            *remaining = remaining.saturating_sub(listing.entries.len());
            let mut nodes = Vec::new();
            for entry in listing.entries {
                let Some(name) = entry.name.to_str().map(str::to_owned) else {
                    continue;
                };
                if should_ignore(&name, entry.kind) {
                    continue;
                }
                match entry.kind {
                    FileKind::Directory => {
                        let children = self
                            .scan_directory(entry.path.clone(), depth.saturating_add(1), remaining)
                            .await?;
                        nodes.push(FileTreeNode {
                            name,
                            path: display_relative(&entry.path),
                            kind: WorkspaceEntryKind::Directory,
                            children,
                            size: None,
                            extension: None,
                        });
                    }
                    FileKind::File => nodes.push(FileTreeNode {
                        extension: extension(entry.path.relative_path()),
                        name,
                        path: display_relative(&entry.path),
                        kind: WorkspaceEntryKind::File,
                        children: Vec::new(),
                        size: Some(entry.byte_length),
                    }),
                    FileKind::SymbolicLink | FileKind::Other => {}
                }
            }
            nodes.sort_by(|left, right| {
                entry_kind_rank(left.kind)
                    .cmp(&entry_kind_rank(right.kind))
                    .then_with(|| compare_names(&left.name, &right.name))
            });
            Ok(nodes)
        })
    }

    async fn directory_preview(
        &self,
        path: String,
        directory: &SafeWorkspacePath,
    ) -> Result<FilePreview, AppError> {
        let listing = self
            .filesystem
            .read_directory(directory, self.limits.max_directory_preview_entries)
            .await?;
        let mut names = listing
            .entries
            .into_iter()
            .filter_map(|entry| entry.name.into_string().ok())
            .collect::<Vec<_>>();
        names.sort_by(|left, right| compare_names(left, right));
        let mut content = format!(
            "[Directory preview] {path}\n\nThis directory contains:\n\n{}",
            names
                .iter()
                .map(|name| format!("  {name}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
        if listing.truncated {
            content.push_str("\n  [additional entries omitted]");
        }
        Ok(FilePreview {
            path,
            content,
            truncated: listing.truncated,
            total_lines: names.len(),
        })
    }

    async fn detect_node_package_manager(&self) -> Result<Option<String>, AppError> {
        for (file, manager) in [
            ("pnpm-lock.yaml", "pnpm"),
            ("yarn.lock", "yarn"),
            ("bun.lock", "bun"),
            ("bun.lockb", "bun"),
            ("package-lock.json", "npm"),
        ] {
            let path = self.filesystem.resolve(Path::new(file)).await?;
            match self.filesystem.metadata(&path).await {
                Ok(metadata) if metadata.kind == FileKind::File => {
                    return Ok(Some(manager.to_string()));
                }
                Ok(_) => {}
                Err(error) if error.kind() == AppErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(None)
    }
}

fn validate_limits(limits: WorkspaceLimits) -> Result<(), AppError> {
    if limits.max_entries == 0
        || limits.max_tree_depth == 0
        || limits.max_file_bytes == 0
        || limits.max_preview_bytes == 0
        || limits.max_preview_lines == 0
        || limits.max_directory_preview_entries == 0
    {
        return Err(AppError::internal("workspace limits must all be positive"));
    }
    Ok(())
}

fn should_ignore(name: &str, kind: FileKind) -> bool {
    if name.starts_with('.') && !(kind == FileKind::File && name == ".gitignore") {
        return true;
    }
    match kind {
        FileKind::Directory => IGNORED_DIRECTORIES
            .iter()
            .any(|ignored| name.eq_ignore_ascii_case(ignored)),
        FileKind::File => extension(Path::new(name)).is_some_and(|value| {
            IGNORED_EXTENSIONS
                .iter()
                .any(|ignored| value.eq_ignore_ascii_case(ignored))
        }),
        FileKind::SymbolicLink | FileKind::Other => true,
    }
}

fn is_binary_extension(path: &Path) -> bool {
    extension(path).is_some_and(|value| {
        BINARY_EXTENSIONS
            .iter()
            .any(|binary| value.eq_ignore_ascii_case(binary))
    })
}

fn extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(|value| format!(".{value}").to_lowercase())
}

fn display_relative(path: &SafeWorkspacePath) -> String {
    path.relative_path().to_string_lossy().into_owned()
}

fn compare_names(left: &str, right: &str) -> std::cmp::Ordering {
    left.to_lowercase()
        .cmp(&right.to_lowercase())
        .then_with(|| left.cmp(right))
}

const fn entry_kind_rank(kind: WorkspaceEntryKind) -> u8 {
    match kind {
        WorkspaceEntryKind::Directory => 0,
        WorkspaceEntryKind::File => 1,
    }
}

fn entry_limit_error(limit: usize) -> AppError {
    AppError::validation(format!(
        "Workspace contains more than the {limit}-entry scan limit"
    ))
}

fn truncate_text(content: &str, max_bytes: usize, max_lines: usize) -> (String, bool) {
    let total_lines = content.split('\n').count();
    if content.len() <= max_bytes && total_lines <= max_lines {
        return (content.to_string(), false);
    }
    let line_limited = content
        .split('\n')
        .take(max_lines)
        .collect::<Vec<_>>()
        .join("\n");
    let mut end = line_limited.len().min(max_bytes);
    while !line_limited.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    (line_limited[..end].to_string(), true)
}

#[cfg(test)]
mod tests {
    use super::truncate_text;

    #[test]
    fn preview_truncation_respects_utf8_byte_and_line_boundaries() {
        let content = "一二三\nline-two\nline-three";
        let (preview, truncated) = truncate_text(content, 10, 2);

        assert!(truncated);
        assert!(preview.is_char_boundary(preview.len()));
        assert!(preview.len() <= 10 && preview.split('\n').count() <= 2);
    }
}
