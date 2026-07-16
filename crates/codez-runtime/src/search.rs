use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::Arc,
};

use codez_core::{
    AppError, CancellationToken, FileKind, FileSystem, ProcessOutput, ProcessRequest, ProcessRunner,
};
use globset::{Glob, GlobMatcher};

/// Options controlling grep output format and filtering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrepOptions {
    pub output_mode: GrepOutputMode,
    pub glob_filter: Option<String>,
    pub type_filter: Option<String>,
    pub case_insensitive: bool,
    pub multiline: bool,
    pub context_after: Option<u32>,
    pub context_before: Option<u32>,
    pub context_around: Option<u32>,
    pub line_numbers: bool,
    pub only_matching: bool,
    pub head_limit: Option<usize>,
    pub offset: Option<usize>,
}

impl Default for GrepOptions {
    fn default() -> Self {
        Self {
            output_mode: GrepOutputMode::FilesWithMatches,
            glob_filter: None,
            type_filter: None,
            case_insensitive: false,
            multiline: false,
            context_after: None,
            context_before: None,
            context_around: None,
            line_numbers: false,
            only_matching: false,
            head_limit: None,
            offset: None,
        }
    }
}

/// Grep output format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrepOutputMode {
    FilesWithMatches,
    Content,
    Count,
}

/// Result of a glob file search.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobResult {
    pub paths: Vec<String>,
    pub truncated: bool,
    pub total: usize,
}

/// Result of a grep content search.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrepResult {
    pub lines: Vec<String>,
    pub truncated: bool,
}

const DEFAULT_GLOB_LIMIT: usize = 1_000;
const MAX_GLOB_LIMIT: usize = 5_000;
const MAX_GLOB_ENTRIES: usize = 100_000;
const GREP_TIMEOUT_SECS: u64 = 60;
const GREP_MAX_OUTPUT: u64 = 32 * 1024 * 1024;

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

/// Workspace search service providing glob pattern matching and grep via ripgrep.
pub struct SearchService {
    rg_path: PathBuf,
    process_runner: Arc<dyn ProcessRunner>,
}

impl std::fmt::Debug for SearchService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SearchService")
            .field("rg_path", &self.rg_path)
            .finish_non_exhaustive()
    }
}

impl SearchService {
    /// Creates a search service with a validated ripgrep path and process runner.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the ripgrep path is not absolute.
    pub fn new(
        rg_path: PathBuf,
        process_runner: Arc<dyn ProcessRunner>,
    ) -> Result<Self, AppError> {
        if !rg_path.is_absolute() {
            return Err(AppError::validation(
                "Ripgrep executable path must be absolute",
            ));
        }
        Ok(Self {
            rg_path,
            process_runner,
        })
    }

    /// Finds files matching a glob pattern within the workspace.
    ///
    /// Uses pure Rust glob matching with recursive directory traversal.
    /// Results are returned as workspace-relative posix paths.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] for invalid patterns, path escapes, or filesystem failures.
    pub async fn glob_files(
        &self,
        filesystem: &dyn FileSystem,
        pattern: &str,
        sub_path: Option<&str>,
        head_limit: Option<usize>,
    ) -> Result<GlobResult, AppError> {
        let matcher = build_glob_matcher(pattern)?;
        let limit = normalize_limit(head_limit);
        let start = resolve_sub_path(filesystem, sub_path).await?;
        let mut queue = VecDeque::from([start]);
        let mut matches = Vec::new();
        let mut scanned = 0usize;

        while let Some(directory) = queue.pop_front() {
            if scanned >= MAX_GLOB_ENTRIES {
                break;
            }
            let listing = filesystem
                .read_directory(&directory, MAX_GLOB_ENTRIES.saturating_sub(scanned))
                .await?;
            scanned = scanned.saturating_add(listing.entries.len());

            for entry in listing.entries {
                let Some(name) = entry.name.to_str() else {
                    continue;
                };
                if entry.kind == FileKind::Directory {
                    if !should_ignore_dir(name) {
                        queue.push_back(entry.path);
                    }
                    continue;
                }
                if entry.kind != FileKind::File {
                    continue;
                }
                let relative = to_posix(&entry.path.relative_path().to_string_lossy());
                if matcher.is_match(&relative) {
                    matches.push(relative);
                }
            }
        }

        let total = matches.len();
        let truncated = total > limit;
        matches.truncate(limit);

        Ok(GlobResult {
            paths: matches,
            truncated,
            total,
        })
    }

    /// Searches file contents using ripgrep through the process runner port.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the ripgrep process fails or the path escapes.
    pub async fn grep(
        &self,
        workspace_root: &Path,
        pattern: &str,
        sub_path: Option<&str>,
        options: &GrepOptions,
        cancellation: CancellationToken,
    ) -> Result<GrepResult, AppError> {
        if pattern.is_empty() {
            return Err(AppError::validation("Search pattern must not be empty"));
        }
        let search_dir = resolve_grep_dir(workspace_root, sub_path)?;
        let rg_args = build_rg_args(pattern, &search_dir, options);
        let request = ProcessRequest {
            program: self.rg_path.clone(),
            arguments: rg_args.into_iter().map(Into::into).collect(),
            current_directory: search_dir.clone(),
            environment: std::collections::BTreeMap::new(),
            timeout: std::time::Duration::from_secs(GREP_TIMEOUT_SECS),
            max_output_bytes: GREP_MAX_OUTPUT,
        };

        let output = self.process_runner.run(request, cancellation).await;
        let output = match output {
            Ok(output) => output,
            Err(error) if error.kind() == codez_core::AppErrorKind::ProcessFailed => {
                // rg exits 1 for no matches
                return Ok(GrepResult {
                    lines: Vec::new(),
                    truncated: false,
                });
            }
            Err(error) => return Err(error),
        };

        parse_grep_output(output, workspace_root, &search_dir, options)
    }
}

fn build_glob_matcher(pattern: &str) -> Result<GlobMatcher, AppError> {
    let glob = Glob::new(pattern)
        .map_err(|source| AppError::validation(format!("Invalid glob pattern: {source}")))?;
    Ok(glob.compile_matcher())
}

fn normalize_limit(head_limit: Option<usize>) -> usize {
    head_limit
        .map(|limit| limit.clamp(1, MAX_GLOB_LIMIT))
        .unwrap_or(DEFAULT_GLOB_LIMIT)
}

async fn resolve_sub_path(
    filesystem: &dyn FileSystem,
    sub_path: Option<&str>,
) -> Result<codez_core::SafeWorkspacePath, AppError> {
    let relative = sub_path.unwrap_or("");
    filesystem.resolve(Path::new(relative)).await
}

fn resolve_grep_dir(workspace_root: &Path, sub_path: Option<&str>) -> Result<PathBuf, AppError> {
    let dir = match sub_path {
        Some(relative) => {
            let resolved = workspace_root.join(relative);
            let canonical = dunce::canonicalize(&resolved).map_err(|_| {
                AppError::validation("Search path does not exist or is inaccessible")
            })?;
            let ws_canonical = dunce::canonicalize(workspace_root).map_err(|_| {
                AppError::validation("Workspace root does not exist or is inaccessible")
            })?;
            if !canonical.starts_with(&ws_canonical) {
                return Err(AppError::validation(
                    "Search path is outside of the workspace",
                ));
            }
            canonical
        }
        None => workspace_root.to_path_buf(),
    };
    Ok(dir)
}

fn should_ignore_dir(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    IGNORED_DIRECTORIES
        .iter()
        .any(|ignored| name.eq_ignore_ascii_case(ignored))
}

fn to_posix(path: &str) -> String {
    path.replace('\\', "/")
}

fn build_rg_args(pattern: &str, search_dir: &Path, options: &GrepOptions) -> Vec<String> {
    let mut args = vec!["--no-heading".to_string(), "--color".to_string(), "never".to_string()];

    match options.output_mode {
        GrepOutputMode::FilesWithMatches => args.push("-l".to_string()),
        GrepOutputMode::Count => args.push("-c".to_string()),
        GrepOutputMode::Content => {
            if options.line_numbers {
                args.push("-n".to_string());
            }
            if options.only_matching {
                args.push("-o".to_string());
            }
        }
    }

    if let Some(after) = options.context_after {
        args.extend(["-A".to_string(), after.to_string()]);
    }
    if let Some(before) = options.context_before {
        args.extend(["-B".to_string(), before.to_string()]);
    }
    if let Some(around) = options.context_around {
        args.extend(["-C".to_string(), around.to_string()]);
    }
    if options.case_insensitive {
        args.push("-i".to_string());
    }
    if options.multiline {
        args.push("--multiline".to_string());
    }
    if let Some(ref glob_filter) = options.glob_filter {
        args.extend(["--glob".to_string(), glob_filter.clone()]);
    }
    if let Some(ref type_filter) = options.type_filter {
        args.extend(["--type".to_string(), type_filter.clone()]);
    }

    args.push("--".to_string());
    args.push(pattern.to_string());
    args.push(search_dir.to_string_lossy().into_owned());
    args
}

fn parse_grep_output(
    output: ProcessOutput,
    workspace_root: &Path,
    search_dir: &Path,
    options: &GrepOptions,
) -> Result<GrepResult, AppError> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines: Vec<String> = stdout
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(|line| relativize_grep_line(line, workspace_root, search_dir))
        .map(|line| to_posix(&line))
        .collect();

    if let Some(offset) = options.offset {
        if offset > 0 && offset < lines.len() {
            lines = lines.split_off(offset);
        } else if offset >= lines.len() {
            lines.clear();
        }
    }

    let truncated = options
        .head_limit
        .is_some_and(|limit| limit > 0 && lines.len() > limit);
    if let Some(limit) = options.head_limit {
        if limit > 0 {
            lines.truncate(limit);
        }
    }

    Ok(GrepResult { lines, truncated })
}

fn relativize_grep_line(line: &str, workspace_root: &Path, search_dir: &Path) -> String {
    let Some(colon_pos) = line.find(':') else {
        return relativize_path(line, workspace_root, search_dir);
    };
    let path_part = &line[..colon_pos];
    let rest = &line[colon_pos..];
    let relative = relativize_path(path_part, workspace_root, search_dir);
    format!("{relative}{rest}")
}

fn relativize_path(path_str: &str, workspace_root: &Path, search_dir: &Path) -> String {
    let path = Path::new(path_str);
    if path.is_absolute() {
        if let Ok(relative) = path.strip_prefix(workspace_root) {
            return relative.to_string_lossy().into_owned();
        }
    }
    if path_str.starts_with("./") {
        return path_str[2..].to_string();
    }
    if let Ok(absolute) = search_dir.join(path_str).canonicalize() {
        if let Ok(relative) = absolute.strip_prefix(workspace_root) {
            return relative.to_string_lossy().into_owned();
        }
    }
    path_str.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matcher_accepts_valid_patterns() {
        let matcher = build_glob_matcher("**/*.ts").expect("valid glob must compile");
        assert!(matcher.is_match("src/app.ts"));
        assert!(!matcher.is_match("src/app.js"));
    }

    #[test]
    fn glob_matcher_rejects_invalid_patterns() {
        let result = build_glob_matcher("[invalid");
        assert!(result.is_err());
    }

    #[test]
    fn normalize_limit_clamps_to_bounds() {
        assert_eq!(normalize_limit(None), DEFAULT_GLOB_LIMIT);
        assert_eq!(normalize_limit(Some(0)), 1);
        assert_eq!(normalize_limit(Some(10_000)), MAX_GLOB_LIMIT);
        assert_eq!(normalize_limit(Some(500)), 500);
    }

    #[test]
    fn ignored_directories_are_rejected() {
        assert!(should_ignore_dir("node_modules"));
        assert!(should_ignore_dir(".git"));
        assert!(should_ignore_dir(".hidden"));
        assert!(!should_ignore_dir("src"));
    }

    #[test]
    fn rg_args_build_files_with_matches_mode() {
        let options = GrepOptions::default();
        let args = build_rg_args("pattern", Path::new("/workspace"), &options);
        assert!(args.contains(&"-l".to_string()));
        assert!(args.contains(&"pattern".to_string()));
    }

    #[test]
    fn rg_args_build_content_mode_with_options() {
        let options = GrepOptions {
            output_mode: GrepOutputMode::Content,
            line_numbers: true,
            case_insensitive: true,
            context_around: Some(3),
            glob_filter: Some("**/*.ts".to_string()),
            ..Default::default()
        };
        let args = build_rg_args("error", Path::new("/ws"), &options);
        assert!(args.contains(&"-n".to_string()));
        assert!(args.contains(&"-i".to_string()));
        assert!(args.contains(&"-C".to_string()));
        assert!(args.contains(&"**/*.ts".to_string()));
    }

    #[test]
    fn posix_conversion_replaces_backslashes() {
        assert_eq!(to_posix("src\\app\\main.ts"), "src/app/main.ts");
        assert_eq!(to_posix("already/posix"), "already/posix");
    }

    #[test]
    fn relativize_strips_workspace_prefix() {
        let ws = Path::new("C:\\project");
        let dir = Path::new("C:\\project\\src");
        let result = relativize_path("C:\\project\\src\\main.rs", ws, dir);
        assert_eq!(result, "src\\main.rs");
    }

    #[test]
    fn relativize_handles_dot_slash_prefix() {
        let ws = Path::new("/project");
        let dir = Path::new("/project");
        let result = relativize_path("./src/main.rs", ws, dir);
        assert_eq!(result, "src/main.rs");
    }
}
