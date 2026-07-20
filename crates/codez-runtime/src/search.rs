use std::{
    collections::VecDeque,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use codez_core::{
    AppError, AppErrorKind, CancellationToken, FileKind, FileSystem, ProcessOutput, ProcessRequest,
    ProcessRunner, SafeWorkspacePath,
};
use globset::{Glob, GlobMatcher};
use thiserror::Error;

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

/// Typed failures raised by bounded workspace search operations.
#[derive(Debug, Error)]
pub enum SearchError {
    #[error("{0}")]
    InvalidInput(String),
    #[error("the search path is outside the verified workspace or contains a link")]
    PathNotAuthorized,
    #[error("the search path is not a directory")]
    PathNotDirectory,
    #[error("the search path is not a regular file or directory")]
    PathNotSearchable,
    #[error("the bundled ripgrep executable is unavailable")]
    RipgrepUnavailable,
    #[error("the search was cancelled")]
    Cancelled,
    #[error("the search exceeded its time limit")]
    TimedOut,
    #[error("ripgrep failed")]
    RipgrepFailed {
        #[source]
        source: Box<AppError>,
    },
    #[error("the workspace search failed")]
    Workspace {
        #[source]
        source: Box<AppError>,
    },
}

impl SearchError {
    /// Stable code used by tool adapters without parsing error messages.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::InvalidInput(_) => "TOOL_SEARCH_INPUT_INVALID",
            Self::PathNotAuthorized => "TOOL_SEARCH_PATH_NOT_AUTHORIZED",
            Self::PathNotDirectory | Self::PathNotSearchable => "TOOL_SEARCH_PATH_INVALID",
            Self::RipgrepUnavailable => "TOOL_SEARCH_UNAVAILABLE",
            Self::Cancelled => "TOOL_SEARCH_CANCELLED",
            Self::TimedOut => "TOOL_SEARCH_TIMEOUT",
            Self::RipgrepFailed { .. } => "TOOL_SEARCH_FAILED",
            Self::Workspace { source } => match source.kind() {
                AppErrorKind::PermissionDenied => "TOOL_SEARCH_PATH_NOT_AUTHORIZED",
                AppErrorKind::NotFound | AppErrorKind::Validation => "TOOL_SEARCH_PATH_INVALID",
                AppErrorKind::Cancelled => "TOOL_SEARCH_CANCELLED",
                AppErrorKind::Timeout => "TOOL_SEARCH_TIMEOUT",
                _ => "TOOL_SEARCH_FAILED",
            },
        }
    }

    /// Whether repeating the same operation may succeed without changing its input.
    #[must_use]
    pub const fn retryable(&self) -> bool {
        match self {
            Self::TimedOut => true,
            Self::Workspace { source } | Self::RipgrepFailed { source } => source.retryable(),
            _ => false,
        }
    }
}

impl From<SearchError> for AppError {
    fn from(value: SearchError) -> Self {
        match value {
            SearchError::InvalidInput(message) => AppError::validation(message),
            SearchError::PathNotAuthorized => {
                AppError::permission_denied("The search path is not allowed")
            }
            SearchError::PathNotDirectory => {
                AppError::validation("The search path must be a directory")
            }
            SearchError::PathNotSearchable => {
                AppError::validation("The search path must be a regular file or directory")
            }
            SearchError::RipgrepUnavailable => {
                AppError::unsupported("The bundled search executable is unavailable")
            }
            SearchError::Cancelled => AppError::cancelled("The search was cancelled"),
            SearchError::TimedOut => AppError::timeout("The search timed out"),
            SearchError::RipgrepFailed { source } | SearchError::Workspace { source } => *source,
        }
    }
}

pub const DEFAULT_GLOB_LIMIT: usize = 100;
pub const MAX_GLOB_LIMIT: usize = 5_000;
pub const MAX_GREP_LIMIT: usize = 5_000;
pub const MAX_SEARCH_PATH_BYTES: usize = 4_096;
pub const MAX_SEARCH_PATTERN_BYTES: usize = 16 * 1_024;
pub const MAX_SEARCH_FILTER_BYTES: usize = 4_096;

const MAX_GLOB_ENTRIES: usize = 100_000;
const DEFAULT_GREP_CONTENT_LIMIT: usize = 200;
const DEFAULT_GREP_FILE_LIMIT: usize = 500;
const MAX_GREP_CONTENT_LIMIT: usize = 2_000;
const MAX_GREP_OFFSET: usize = 100_000;
const MAX_GREP_CONTEXT_LINES: u32 = 1_000;
const SEARCH_TIMEOUT: Duration = Duration::from_secs(30);
const GREP_MAX_OUTPUT: u64 = 4 * 1_024 * 1_024;

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

/// Workspace search service providing glob matching and supervised ripgrep execution.
#[derive(Clone)]
pub struct SearchService {
    rg_path: PathBuf,
    process_runner: Arc<dyn ProcessRunner>,
}

impl std::fmt::Debug for SearchService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SearchService")
            .field("rg_path", &self.rg_path)
            .finish_non_exhaustive()
    }
}

impl SearchService {
    /// Creates a search service with a trusted ripgrep location and process runner.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the ripgrep path is not absolute. File presence is checked at
    /// execution time so a missing packaged resource becomes a typed unavailable result.
    pub fn new(rg_path: PathBuf, process_runner: Arc<dyn ProcessRunner>) -> Result<Self, AppError> {
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

    /// Finds files matching a glob pattern within a verified workspace.
    ///
    /// # Errors
    ///
    /// Returns [`SearchError`] for invalid patterns, unsafe paths, timeouts, or filesystem errors.
    pub async fn glob_files(
        &self,
        filesystem: &dyn FileSystem,
        pattern: &str,
        sub_path: Option<&str>,
        head_limit: Option<usize>,
    ) -> Result<GlobResult, SearchError> {
        self.glob_files_cancellable(
            filesystem,
            pattern,
            sub_path,
            head_limit,
            CancellationToken::new(),
        )
        .await
    }

    /// Finds files with explicit cancellation in addition to the fixed deadline.
    ///
    /// # Errors
    ///
    /// Returns [`SearchError`] for invalid input, unsafe paths, cancellation, timeouts, or I/O.
    pub async fn glob_files_cancellable(
        &self,
        filesystem: &dyn FileSystem,
        pattern: &str,
        sub_path: Option<&str>,
        head_limit: Option<usize>,
        cancellation: CancellationToken,
    ) -> Result<GlobResult, SearchError> {
        validate_required_text("Glob pattern", pattern, MAX_SEARCH_PATTERN_BYTES)?;
        let matcher = build_glob_matcher(pattern)?;
        let limit = normalize_limit(head_limit, DEFAULT_GLOB_LIMIT, MAX_GLOB_LIMIT);
        let operation = self.glob_inner(filesystem, &matcher, sub_path, limit, &cancellation);
        tokio::select! {
            () = cancellation.cancelled() => Err(SearchError::Cancelled),
            result = tokio::time::timeout(SEARCH_TIMEOUT, operation) => {
                result.map_err(|_| SearchError::TimedOut)?
            }
        }
    }

    async fn glob_inner(
        &self,
        filesystem: &dyn FileSystem,
        matcher: &GlobMatcher,
        sub_path: Option<&str>,
        limit: usize,
        cancellation: &CancellationToken,
    ) -> Result<GlobResult, SearchError> {
        let start = resolve_search_directory(filesystem, sub_path).await?;
        let match_root = start.relative_path().to_path_buf();
        let mut queue = VecDeque::from([start]);
        let mut matches = Vec::new();
        let mut scanned = 0_usize;
        let mut scan_truncated = false;

        while let Some(directory) = queue.pop_front() {
            if cancellation.is_cancelled() {
                return Err(SearchError::Cancelled);
            }
            if scanned >= MAX_GLOB_ENTRIES {
                scan_truncated = true;
                break;
            }
            let listing = filesystem
                .read_directory(&directory, MAX_GLOB_ENTRIES.saturating_sub(scanned))
                .await
                .map_err(workspace_error)?;
            scanned = scanned.saturating_add(listing.entries.len());
            scan_truncated |= listing.truncated;

            for entry in listing.entries {
                if cancellation.is_cancelled() {
                    return Err(SearchError::Cancelled);
                }
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
                let workspace_relative = to_posix(&entry.path.relative_path().to_string_lossy());
                let pattern_relative = entry
                    .path
                    .relative_path()
                    .strip_prefix(&match_root)
                    .map_or(entry.path.relative_path(), |relative| relative);
                if matcher.is_match(to_posix(&pattern_relative.to_string_lossy())) {
                    matches.push(workspace_relative);
                }
            }
        }

        matches.sort_unstable();
        matches.dedup();
        let total = matches.len();
        let truncated = scan_truncated || total > limit;
        matches.truncate(limit);
        Ok(GlobResult {
            paths: matches,
            truncated,
            total,
        })
    }

    /// Searches file contents using ripgrep through the supervised process port.
    ///
    /// # Errors
    ///
    /// Returns [`SearchError`] for invalid input, unsafe paths, unavailable ripgrep, cancellation,
    /// timeout, or a genuine ripgrep failure. Ripgrep exit code 1 with empty stderr is no-match.
    pub async fn grep(
        &self,
        workspace_root: &Path,
        pattern: &str,
        sub_path: Option<&str>,
        options: &GrepOptions,
        cancellation: CancellationToken,
    ) -> Result<GrepResult, SearchError> {
        let (search_path, kind) = resolve_native_search_target(workspace_root, sub_path).await?;
        self.grep_target(
            workspace_root,
            &search_path,
            kind,
            pattern,
            options,
            cancellation,
        )
        .await
    }

    /// Searches contents using the same workspace filesystem authority as the tool pipeline.
    ///
    /// # Errors
    ///
    /// Returns [`SearchError`] under the same conditions as [`Self::grep`].
    pub async fn grep_filesystem(
        &self,
        filesystem: &dyn FileSystem,
        pattern: &str,
        sub_path: Option<&str>,
        options: &GrepOptions,
        cancellation: CancellationToken,
    ) -> Result<GrepResult, SearchError> {
        let (search_path, kind) = resolve_search_target(filesystem, sub_path).await?;
        self.grep_target(
            filesystem.workspace_root().as_path(),
            &search_path.absolute_path(),
            kind,
            pattern,
            options,
            cancellation,
        )
        .await
    }

    async fn grep_target(
        &self,
        workspace_root: &Path,
        search_path: &Path,
        search_kind: FileKind,
        pattern: &str,
        options: &GrepOptions,
        cancellation: CancellationToken,
    ) -> Result<GrepResult, SearchError> {
        validate_required_text("Search pattern", pattern, MAX_SEARCH_PATTERN_BYTES)?;
        validate_grep_options(options)?;
        ensure_ripgrep_available(&self.rg_path).await?;
        let (search_dir, target) = match search_kind {
            FileKind::Directory => (search_path.to_path_buf(), PathBuf::from(".")),
            FileKind::File => {
                let parent = search_path.parent().ok_or(SearchError::PathNotSearchable)?;
                let file_name = search_path
                    .file_name()
                    .ok_or(SearchError::PathNotSearchable)?;
                (parent.to_path_buf(), PathBuf::from(file_name))
            }
            FileKind::SymbolicLink | FileKind::Other => {
                return Err(SearchError::PathNotSearchable);
            }
        };
        let request = ProcessRequest {
            program: self.rg_path.clone(),
            arguments: build_rg_args(pattern, options, &target)
                .into_iter()
                .map(Into::into)
                .collect(),
            current_directory: search_dir.clone(),
            environment: std::collections::BTreeMap::new(),
            timeout: SEARCH_TIMEOUT,
            max_output_bytes: GREP_MAX_OUTPUT,
        };

        let output = self.process_runner.run(request, cancellation).await;
        let output = match output {
            Ok(output) => output,
            Err(error) if is_rg_no_match(&error) => {
                return Ok(GrepResult {
                    lines: Vec::new(),
                    truncated: false,
                });
            }
            Err(error) if error.kind() == AppErrorKind::Cancelled => {
                return Err(SearchError::Cancelled);
            }
            Err(error) if error.kind() == AppErrorKind::Timeout => {
                return Err(SearchError::TimedOut);
            }
            Err(error) => {
                return Err(SearchError::RipgrepFailed {
                    source: Box::new(error),
                });
            }
        };

        parse_grep_output(output, workspace_root, &search_dir, options)
    }
}

/// Resolves a directory without permitting path escape, symlink, or Windows reparse traversal.
///
/// # Errors
///
/// Returns [`SearchError`] when the path is invalid, unsafe, missing, or not a directory.
pub async fn resolve_search_directory(
    filesystem: &dyn FileSystem,
    sub_path: Option<&str>,
) -> Result<SafeWorkspacePath, SearchError> {
    let input = sub_path.unwrap_or(".");
    validate_path_text(input)?;
    reject_link_components(filesystem.workspace_root().as_path(), Path::new(input)).await?;
    let resolved = filesystem
        .resolve(Path::new(input))
        .await
        .map_err(workspace_error)?;
    let metadata = filesystem
        .metadata(&resolved)
        .await
        .map_err(workspace_error)?;
    if metadata.kind != FileKind::Directory {
        return Err(SearchError::PathNotDirectory);
    }
    Ok(resolved)
}

async fn resolve_search_target(
    filesystem: &dyn FileSystem,
    sub_path: Option<&str>,
) -> Result<(SafeWorkspacePath, FileKind), SearchError> {
    let input = sub_path.unwrap_or(".");
    validate_path_text(input)?;
    reject_link_components(filesystem.workspace_root().as_path(), Path::new(input)).await?;
    let resolved = filesystem
        .resolve(Path::new(input))
        .await
        .map_err(workspace_error)?;
    let metadata = filesystem
        .metadata(&resolved)
        .await
        .map_err(workspace_error)?;
    match metadata.kind {
        FileKind::File | FileKind::Directory => Ok((resolved, metadata.kind)),
        FileKind::SymbolicLink | FileKind::Other => Err(SearchError::PathNotSearchable),
    }
}

fn build_glob_matcher(pattern: &str) -> Result<GlobMatcher, SearchError> {
    Glob::new(pattern)
        .map(|glob| glob.compile_matcher())
        .map_err(|source| SearchError::InvalidInput(format!("Invalid glob pattern: {source}")))
}

fn normalize_limit(value: Option<usize>, default: usize, maximum: usize) -> usize {
    value.map_or(default, |limit| limit.clamp(1, maximum))
}

fn validate_required_text(
    label: &str,
    value: &str,
    maximum_bytes: usize,
) -> Result<(), SearchError> {
    if value.is_empty() {
        return Err(SearchError::InvalidInput(format!(
            "{label} must not be empty"
        )));
    }
    if value.len() > maximum_bytes {
        return Err(SearchError::InvalidInput(format!(
            "{label} exceeds its {maximum_bytes}-byte limit"
        )));
    }
    if value.chars().any(|character| character == '\0') {
        return Err(SearchError::InvalidInput(format!(
            "{label} contains an invalid character"
        )));
    }
    Ok(())
}

fn validate_path_text(value: &str) -> Result<(), SearchError> {
    validate_required_text("Search path", value, MAX_SEARCH_PATH_BYTES)
}

fn validate_grep_options(options: &GrepOptions) -> Result<(), SearchError> {
    if let Some(filter) = options.glob_filter.as_deref() {
        validate_required_text("Glob filter", filter, MAX_SEARCH_FILTER_BYTES)?;
    }
    if let Some(filter) = options.type_filter.as_deref() {
        validate_required_text("Type filter", filter, MAX_SEARCH_FILTER_BYTES)?;
    }
    for (label, value) in [
        ("after-context", options.context_after),
        ("before-context", options.context_before),
        ("around-context", options.context_around),
    ] {
        if value.is_some_and(|lines| lines > MAX_GREP_CONTEXT_LINES) {
            return Err(SearchError::InvalidInput(format!(
                "{label} exceeds {MAX_GREP_CONTEXT_LINES} lines"
            )));
        }
    }
    if options
        .offset
        .is_some_and(|offset| offset > MAX_GREP_OFFSET)
    {
        return Err(SearchError::InvalidInput(format!(
            "Search offset exceeds {MAX_GREP_OFFSET} entries"
        )));
    }
    Ok(())
}

async fn resolve_native_search_target(
    workspace_root: &Path,
    sub_path: Option<&str>,
) -> Result<(PathBuf, FileKind), SearchError> {
    if !workspace_root.is_absolute() || !workspace_root.is_dir() {
        return Err(SearchError::PathNotAuthorized);
    }
    let input = sub_path.unwrap_or(".");
    validate_path_text(input)?;
    reject_link_components(workspace_root, Path::new(input)).await?;
    let candidate = if Path::new(input).is_absolute() {
        PathBuf::from(input)
    } else {
        workspace_root.join(input)
    };
    let canonical = dunce::canonicalize(candidate).map_err(|_| SearchError::PathNotAuthorized)?;
    if !canonical.starts_with(workspace_root) {
        return Err(SearchError::PathNotAuthorized);
    }
    if canonical.is_dir() {
        return Ok((canonical, FileKind::Directory));
    }
    if canonical.is_file() {
        return Ok((canonical, FileKind::File));
    }
    Err(SearchError::PathNotSearchable)
}

async fn reject_link_components(
    workspace_root: &Path,
    requested: &Path,
) -> Result<(), SearchError> {
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        workspace_root.join(requested)
    };
    let relative = candidate
        .strip_prefix(workspace_root)
        .map_err(|_| SearchError::PathNotAuthorized)?;
    let mut current = workspace_root.to_path_buf();
    for component in relative.components() {
        match component {
            Component::CurDir => continue,
            Component::Normal(part) => current.push(part),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(SearchError::PathNotAuthorized);
            }
        }
        let metadata = tokio::fs::symlink_metadata(&current)
            .await
            .map_err(|source| SearchError::Workspace {
                source: Box::new(match source.kind() {
                    std::io::ErrorKind::NotFound => {
                        AppError::not_found("The search path does not exist")
                    }
                    std::io::ErrorKind::PermissionDenied => {
                        AppError::permission_denied("The search path is not accessible")
                    }
                    _ => AppError::external(
                        "The search path could not be inspected",
                        source.to_string(),
                        true,
                    ),
                }),
            })?;
        if metadata_is_link_or_reparse(&metadata) {
            return Err(SearchError::PathNotAuthorized);
        }
    }
    Ok(())
}

fn metadata_is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

async fn ensure_ripgrep_available(path: &Path) -> Result<(), SearchError> {
    match tokio::fs::metadata(path).await {
        Ok(metadata) if metadata.is_file() => Ok(()),
        Ok(_) | Err(_) => Err(SearchError::RipgrepUnavailable),
    }
}

fn workspace_error(source: AppError) -> SearchError {
    match source.kind() {
        AppErrorKind::Cancelled => SearchError::Cancelled,
        AppErrorKind::Timeout => SearchError::TimedOut,
        _ => SearchError::Workspace {
            source: Box::new(source),
        },
    }
}

fn is_rg_no_match(error: &AppError) -> bool {
    if error.kind() != AppErrorKind::ProcessFailed {
        return false;
    }
    let Some(diagnostic) = error.diagnostic() else {
        return false;
    };
    let Some((status, stderr)) = diagnostic.split_once("; stderr=") else {
        return false;
    };
    matches!(status, "status=exit code: 1" | "status=exit status: 1") && stderr.is_empty()
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

fn build_rg_args(pattern: &str, options: &GrepOptions, target: &Path) -> Vec<String> {
    let mut arguments = vec![
        "--no-heading".to_string(),
        "--color".to_string(),
        "never".to_string(),
        "--no-follow".to_string(),
        "--sort".to_string(),
        "path".to_string(),
    ];

    match options.output_mode {
        GrepOutputMode::FilesWithMatches => arguments.push("-l".to_string()),
        GrepOutputMode::Count => arguments.push("-c".to_string()),
        GrepOutputMode::Content => {
            arguments.push("--with-filename".to_string());
            if options.line_numbers {
                arguments.push("-n".to_string());
            }
            if options.only_matching {
                arguments.push("-o".to_string());
            }
        }
    }

    if let Some(after) = options.context_after {
        arguments.extend(["-A".to_string(), after.to_string()]);
    }
    if let Some(before) = options.context_before {
        arguments.extend(["-B".to_string(), before.to_string()]);
    }
    if let Some(around) = options.context_around {
        arguments.extend(["-C".to_string(), around.to_string()]);
    }
    if options.case_insensitive {
        arguments.push("-i".to_string());
    }
    if options.multiline {
        arguments.push("--multiline".to_string());
    }
    if let Some(glob_filter) = &options.glob_filter {
        arguments.extend(["--glob".to_string(), glob_filter.clone()]);
    }
    if let Some(type_filter) = &options.type_filter {
        arguments.extend(["--type".to_string(), type_filter.clone()]);
    }

    arguments.push("--".to_string());
    arguments.push(pattern.to_string());
    arguments.push(target.to_string_lossy().into_owned());
    arguments
}

fn parse_grep_output(
    output: ProcessOutput,
    workspace_root: &Path,
    search_dir: &Path,
    options: &GrepOptions,
) -> Result<GrepResult, SearchError> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let offset = options.offset.unwrap_or_default();
    let (default_limit, maximum_limit) = grep_result_limits(options.output_mode);
    let limit = normalize_limit(options.head_limit, default_limit, maximum_limit);
    let mut lines = stdout
        .split('\n')
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .map(|line| relativize_grep_line(line, workspace_root, search_dir))
        .map(|line| to_posix(&line))
        .skip(offset)
        .take(limit.saturating_add(1))
        .collect::<Vec<_>>();
    let truncated = output.output_truncated || lines.len() > limit;
    lines.truncate(limit);
    Ok(GrepResult { lines, truncated })
}

const fn grep_result_limits(mode: GrepOutputMode) -> (usize, usize) {
    match mode {
        GrepOutputMode::Content => (DEFAULT_GREP_CONTENT_LIMIT, MAX_GREP_CONTENT_LIMIT),
        GrepOutputMode::FilesWithMatches | GrepOutputMode::Count => {
            (DEFAULT_GREP_FILE_LIMIT, MAX_GREP_LIMIT)
        }
    }
}

fn relativize_grep_line(line: &str, workspace_root: &Path, search_dir: &Path) -> String {
    if line == "--" {
        return line.to_string();
    }
    let Some((path_part, rest)) = split_grep_path(line) else {
        return relativize_path(line, workspace_root, search_dir);
    };
    let relative = relativize_path(path_part, workspace_root, search_dir);
    format!("{relative}{rest}")
}

fn split_grep_path(line: &str) -> Option<(&str, &str)> {
    #[cfg(windows)]
    let start = if line.as_bytes().get(1) == Some(&b':') {
        2
    } else {
        0
    };
    #[cfg(not(windows))]
    let start = 0;
    line[start..]
        .find(':')
        .map(|index| start + index)
        .map(|index| (&line[..index], &line[index..]))
}

fn relativize_path(path_text: &str, workspace_root: &Path, search_dir: &Path) -> String {
    let path = Path::new(path_text);
    if path.is_absolute() {
        if let Ok(relative) = path.strip_prefix(workspace_root) {
            return relative.to_string_lossy().into_owned();
        }
        return path_text.to_string();
    }
    let stripped = path_text.strip_prefix("./").unwrap_or(path_text);
    let absolute = search_dir.join(stripped);
    absolute.strip_prefix(workspace_root).map_or_else(
        |_| path_text.to_string(),
        |relative| relative.to_string_lossy().into_owned(),
    )
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    use super::*;

    enum RunnerResponse {
        Immediate(Result<ProcessOutput, AppError>),
        WaitForCancellation,
    }

    struct ScriptedRunner {
        response: Mutex<Option<RunnerResponse>>,
    }

    impl ProcessRunner for ScriptedRunner {
        fn run<'a>(
            &'a self,
            _request: ProcessRequest,
            cancellation: CancellationToken,
        ) -> codez_core::PortFuture<'a, ProcessOutput> {
            let response = self
                .response
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take()
                .expect("scripted runner must be called exactly once");
            Box::pin(async move {
                match response {
                    RunnerResponse::Immediate(result) => result,
                    RunnerResponse::WaitForCancellation => {
                        cancellation.cancelled().await;
                        Err(AppError::cancelled("fixture cancellation"))
                    }
                }
            })
        }
    }

    fn grep_fixture(
        response: RunnerResponse,
    ) -> (tempfile::TempDir, SearchService, CancellationToken) {
        let workspace = tempfile::tempdir().expect("temporary workspace must be created");
        let executable = workspace.path().join(if cfg!(windows) {
            "rg-fixture.exe"
        } else {
            "rg-fixture"
        });
        std::fs::write(&executable, b"fixture").expect("fixture executable file must be written");
        let runner = ScriptedRunner {
            response: Mutex::new(Some(response)),
        };
        let search = SearchService::new(executable, Arc::new(runner))
            .expect("absolute fixture executable must be accepted");
        (workspace, search, CancellationToken::new())
    }

    #[test]
    fn glob_matcher_accepts_valid_patterns() {
        let matcher = build_glob_matcher("**/*.ts").expect("valid glob must compile");
        assert!(matcher.is_match("src/app.ts") && !matcher.is_match("src/app.js"));
    }

    #[test]
    fn glob_matcher_rejects_invalid_patterns() {
        assert!(matches!(
            build_glob_matcher("[invalid"),
            Err(SearchError::InvalidInput(_))
        ));
    }

    #[test]
    fn normalize_limit_clamps_to_bounds() {
        assert_eq!(
            [
                normalize_limit(None, DEFAULT_GLOB_LIMIT, MAX_GLOB_LIMIT),
                normalize_limit(Some(0), DEFAULT_GLOB_LIMIT, MAX_GLOB_LIMIT),
                normalize_limit(Some(10_000), DEFAULT_GLOB_LIMIT, MAX_GLOB_LIMIT),
            ],
            [DEFAULT_GLOB_LIMIT, 1, MAX_GLOB_LIMIT]
        );
    }

    #[test]
    fn ignored_directories_are_rejected() {
        assert!(
            should_ignore_dir("node_modules")
                && should_ignore_dir(".git")
                && should_ignore_dir(".hidden")
                && !should_ignore_dir("src")
        );
    }

    #[test]
    fn rg_args_are_argument_vector_without_shell_composition() {
        let options = GrepOptions {
            output_mode: GrepOutputMode::Content,
            line_numbers: true,
            case_insensitive: true,
            context_around: Some(3),
            glob_filter: Some("**/*.ts".to_string()),
            ..GrepOptions::default()
        };
        let arguments = build_rg_args("error; exit 9", &options, Path::new("."));
        assert!(
            arguments.windows(2).any(|pair| pair == ["--sort", "path"])
                && arguments.contains(&"error; exit 9".to_string())
                && arguments.last().is_some_and(|value| value == ".")
        );
    }

    #[test]
    fn rg_args_accept_an_explicit_file_target() {
        let arguments = build_rg_args(
            "workspace",
            &GrepOptions::default(),
            Path::new("Cargo.toml"),
        );

        assert_eq!(arguments.last().map(String::as_str), Some("Cargo.toml"));
    }

    #[test]
    fn grep_defaults_bound_content_more_tightly_than_file_discovery() {
        assert_eq!(
            [
                grep_result_limits(GrepOutputMode::Content),
                grep_result_limits(GrepOutputMode::FilesWithMatches),
                grep_result_limits(GrepOutputMode::Count),
            ],
            [(200, 2_000), (500, 5_000), (500, 5_000)]
        );
    }

    #[test]
    fn no_match_requires_exit_one_and_empty_stderr() {
        let no_match = AppError::process_failed("process failed", "status=exit code: 1; stderr=");
        let real_failure =
            AppError::process_failed("process failed", "status=exit code: 2; stderr=regex error");
        assert!(is_rg_no_match(&no_match) && !is_rg_no_match(&real_failure));
    }

    #[test]
    fn grep_output_is_workspace_relative_stable_text() {
        let workspace = Path::new("/workspace");
        let search = Path::new("/workspace/src");
        let output = ProcessOutput {
            exit_code: Some(0),
            stdout: b"./z.rs:2:z\n./a.rs:1:a\n".to_vec(),
            stderr: Vec::new(),
            output_truncated: false,
            elapsed: Duration::from_millis(1),
        };
        let result = parse_grep_output(
            output,
            workspace,
            search,
            &GrepOptions {
                output_mode: GrepOutputMode::Content,
                ..GrepOptions::default()
            },
        )
        .expect("valid output must parse");
        assert_eq!(result.lines, ["src/z.rs:2:z", "src/a.rs:1:a"]);
    }

    #[test]
    fn grep_output_reports_process_and_result_truncation() {
        let output = ProcessOutput {
            exit_code: Some(0),
            stdout: b"a\nb\n".to_vec(),
            stderr: Vec::new(),
            output_truncated: false,
            elapsed: Duration::from_millis(1),
        };
        let result = parse_grep_output(
            output,
            Path::new("/workspace"),
            Path::new("/workspace"),
            &GrepOptions {
                head_limit: Some(1),
                ..GrepOptions::default()
            },
        )
        .expect("valid output must parse");
        assert!(result.truncated && result.lines == ["a"]);
    }

    #[test]
    fn unicode_paths_and_content_remain_intact() {
        let result = relativize_grep_line(
            "./源代码/入口.rs:7:你好",
            Path::new("/工作区"),
            Path::new("/工作区"),
        );
        assert_eq!(result, "源代码/入口.rs:7:你好");
    }

    #[tokio::test]
    async fn grep_treats_only_clean_exit_one_as_no_match() {
        let (workspace, search, cancellation) = grep_fixture(RunnerResponse::Immediate(Err(
            AppError::process_failed("process failed", "status=exit code: 1; stderr="),
        )));
        let root =
            dunce::canonicalize(workspace.path()).expect("fixture workspace must canonicalize");
        let result = search
            .grep(
                &root,
                "missing",
                None,
                &GrepOptions::default(),
                cancellation,
            )
            .await
            .expect("clean ripgrep exit one must mean no match");
        assert_eq!(
            result,
            GrepResult {
                lines: Vec::new(),
                truncated: false
            }
        );
    }

    #[tokio::test]
    async fn grep_accepts_a_regular_file_search_path() {
        let output = ProcessOutput {
            exit_code: Some(0),
            stdout: b"Cargo.toml:1:[workspace]\n".to_vec(),
            stderr: Vec::new(),
            output_truncated: false,
            elapsed: Duration::from_millis(1),
        };
        let (workspace, search, cancellation) = grep_fixture(RunnerResponse::Immediate(Ok(output)));
        std::fs::write(workspace.path().join("Cargo.toml"), "[workspace]\n")
            .expect("fixture target file must be written");
        let root =
            dunce::canonicalize(workspace.path()).expect("fixture workspace must canonicalize");

        let result = search
            .grep(
                &root,
                "workspace",
                Some("Cargo.toml"),
                &GrepOptions {
                    output_mode: GrepOutputMode::Content,
                    line_numbers: true,
                    ..GrepOptions::default()
                },
                cancellation,
            )
            .await
            .expect("a regular file must be a valid grep target");

        assert_eq!(result.lines, ["Cargo.toml:1:[workspace]"]);
    }

    #[tokio::test]
    async fn grep_preserves_a_real_ripgrep_failure() {
        let (workspace, search, cancellation) =
            grep_fixture(RunnerResponse::Immediate(Err(AppError::process_failed(
                "process failed",
                "status=exit code: 2; stderr=invalid regex",
            ))));
        let root =
            dunce::canonicalize(workspace.path()).expect("fixture workspace must canonicalize");
        let error = search
            .grep(
                &root,
                "[invalid",
                None,
                &GrepOptions::default(),
                cancellation,
            )
            .await
            .expect_err("ripgrep exit two must remain a failure");
        assert!(matches!(
            error,
            SearchError::RipgrepFailed { source }
                if source.kind() == AppErrorKind::ProcessFailed
        ));
    }

    #[tokio::test]
    async fn grep_cancellation_is_typed_and_interruptible() {
        let (workspace, search, cancellation) = grep_fixture(RunnerResponse::WaitForCancellation);
        let root =
            dunce::canonicalize(workspace.path()).expect("fixture workspace must canonicalize");
        cancellation.cancel();
        let error = search
            .grep(&root, "needle", None, &GrepOptions::default(), cancellation)
            .await
            .expect_err("cancelled grep must fail");
        assert!(matches!(error, SearchError::Cancelled));
    }

    #[tokio::test]
    async fn search_paths_reject_parent_escape() {
        let workspace = tempfile::tempdir().expect("temporary workspace must be created");
        let root =
            dunce::canonicalize(workspace.path()).expect("fixture workspace must canonicalize");
        let error = resolve_native_search_target(&root, Some("../outside"))
            .await
            .expect_err("parent traversal must be rejected");
        assert!(matches!(error, SearchError::PathNotAuthorized));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn search_paths_reject_symbolic_link_directories() {
        use std::os::unix::fs::symlink;

        let workspace = tempfile::tempdir().expect("temporary workspace must be created");
        let target = workspace.path().join("target");
        std::fs::create_dir(&target).expect("fixture target must be created");
        symlink(&target, workspace.path().join("linked")).expect("fixture symlink must be created");
        let root =
            dunce::canonicalize(workspace.path()).expect("fixture workspace must canonicalize");
        let error = resolve_native_search_target(&root, Some("linked"))
            .await
            .expect_err("linked search path must be rejected");
        assert!(matches!(error, SearchError::PathNotAuthorized));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn search_paths_reject_windows_reparse_directories() {
        use std::os::windows::fs::symlink_dir;

        let workspace = tempfile::tempdir().expect("temporary workspace must be created");
        let target = workspace.path().join("target");
        std::fs::create_dir(&target).expect("fixture target must be created");
        let link = workspace.path().join("linked");
        match symlink_dir(&target, &link) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("fixture reparse directory could not be created: {error}"),
        }
        let root =
            dunce::canonicalize(workspace.path()).expect("fixture workspace must canonicalize");
        let error = resolve_native_search_target(&root, Some("linked"))
            .await
            .expect_err("reparse search path must be rejected");
        assert!(matches!(error, SearchError::PathNotAuthorized));
    }
}
