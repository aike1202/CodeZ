use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};

use codez_core::{AppError, RecentProjectRepository, WorkspaceRoot};
use same_file::Handle;
use serde::{Deserialize, Serialize};
#[cfg(not(windows))]
use tempfile::Builder;
use tokio::sync::Mutex;

use super::path_security::{
    SafeFileName, authorize_workspace, ensure_secure_path, metadata_is_link_or_reparse,
    parse_untrusted_absolute_path, path_io_error, paths_equal, workspace_path,
};
use crate::state::AppState;

const CODEX_SOURCE_NAME: &str = "Codex";
const CLAUDE_SOURCE_NAME: &str = "Claude";
const CUSTOM_SOURCE_NAME: &str = "CUSTOM";

const DEFAULT_MAX_TREE_DEPTH: usize = 16;
const DEFAULT_MAX_TREE_ENTRIES: usize = 4_096;
const DEFAULT_MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_METADATA_NAME_BYTES: usize = 1_024;
const MAX_METADATA_DESCRIPTION_BYTES: usize = 64 * 1024;

static EXTERNAL_SKILL_OPERATIONS: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSkillCheckResult {
    has_updates: bool,
    total_count: usize,
    sources: Vec<ExternalSourceCheck>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalSourceCheck {
    source_name: String,
    count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSkillGroup {
    source_name: String,
    skills: Vec<ExternalSkillItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalSkillItem {
    dir_name: String,
    source_name: String,
    name: String,
    description: String,
    imported: bool,
    has_update: bool,
}

#[derive(Debug, Clone)]
struct SourceRoot {
    name: String,
    path: PathBuf,
    may_be_skill: bool,
}

#[derive(Debug, Clone)]
struct ImportDestination {
    authority_root: PathBuf,
    skills_root: PathBuf,
    staging_root: PathBuf,
}

#[derive(Debug, Clone, Copy)]
struct TreeLimits {
    max_depth: usize,
    max_entries: usize,
    max_file_bytes: u64,
    max_total_bytes: u64,
}

impl Default for TreeLimits {
    fn default() -> Self {
        Self {
            max_depth: DEFAULT_MAX_TREE_DEPTH,
            max_entries: DEFAULT_MAX_TREE_ENTRIES,
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            max_total_bytes: DEFAULT_MAX_TOTAL_BYTES,
        }
    }
}

#[derive(Default)]
struct TreeBudget {
    entries: usize,
    total_bytes: u64,
}

impl TreeBudget {
    fn account_entry(&mut self, limits: TreeLimits) -> Result<(), AppError> {
        self.entries = self
            .entries
            .checked_add(1)
            .ok_or_else(|| AppError::validation("External skill tree is too large"))?;
        if self.entries > limits.max_entries {
            return Err(AppError::validation(format!(
                "External skills exceed the {}-entry limit",
                limits.max_entries
            )));
        }
        Ok(())
    }

    fn account_bytes(&mut self, bytes: u64, limits: TreeLimits) -> Result<(), AppError> {
        self.total_bytes = self
            .total_bytes
            .checked_add(bytes)
            .ok_or_else(|| AppError::validation("External skill content is too large"))?;
        if self.total_bytes > limits.max_total_bytes {
            return Err(AppError::validation(format!(
                "External skills exceed the {}-byte total limit",
                limits.max_total_bytes
            )));
        }
        Ok(())
    }
}

struct TreeFile {
    relative_path: PathBuf,
    bytes: Vec<u8>,
    permissions: fs::Permissions,
}

struct TreeSnapshot {
    directories: Vec<PathBuf>,
    files: Vec<TreeFile>,
}

struct SkillSnapshot {
    dir_name: SafeFileName,
    name: String,
    description: String,
    tree: TreeSnapshot,
}

#[derive(Debug, Deserialize)]
struct SkillFrontmatter {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportDisposition {
    Commit,
    Reuse,
}

struct PlannedImport {
    snapshot: SkillSnapshot,
    destination: PathBuf,
    disposition: ImportDisposition,
}

/// Identities retained for a destination created by this import operation.
///
/// Holding both handles lets the commit and rollback paths detect a renamed or
/// replaced parent/destination before performing further path-based I/O.
struct ReservedImport {
    destination: PathBuf,
    destination_identity: Handle,
    parent: PathBuf,
    parent_identity: Handle,
}

/// A fully materialized import eligible for rollback if a later batch member
/// fails. The open identities keep rollback scoped to the directory this
/// operation created.
struct CommittedImport {
    name: String,
    destination_identity: Handle,
    parent: PathBuf,
    parent_identity: Handle,
}

impl ReservedImport {
    fn verify_identity(&self) -> Result<(), AppError> {
        verify_directory_identity(
            &self.parent,
            &self.parent_identity,
            "skill import parent directory",
        )?;
        verify_directory_identity(
            &self.destination,
            &self.destination_identity,
            "skill import destination",
        )
    }

    #[cfg(windows)]
    fn into_committed(self, name: String) -> CommittedImport {
        CommittedImport {
            name,
            destination_identity: self.destination_identity,
            parent: self.parent,
            parent_identity: self.parent_identity,
        }
    }
}

impl CommittedImport {
    fn verify_identity(&self) -> Result<(), AppError> {
        verify_directory_identity(
            &self.parent,
            &self.parent_identity,
            "skill import parent directory",
        )?;
        verify_directory_identity(
            &self.parent.join(&self.name),
            &self.destination_identity,
            "imported skill destination",
        )
    }
}

pub(super) async fn list_external(
    state: &AppState,
    root_path: Option<&str>,
) -> Result<Vec<ExternalSkillGroup>, AppError> {
    let _guard = EXTERNAL_SKILL_OPERATIONS.lock().await;
    let destination = resolve_destination(state, root_path).await?;
    validate_destination_paths(&destination).await?;
    let sources = default_sources(state);
    validate_default_sources(state, &sources).await?;

    spawn_external_task("list external skills", move || {
        list_external_blocking(&sources, &destination.skills_root, TreeLimits::default())
    })
    .await
}

pub(super) async fn check_external(
    state: &AppState,
    root_path: Option<&str>,
) -> Result<ExternalSkillCheckResult, AppError> {
    let groups = list_external(state, root_path).await?;
    let sources = groups
        .iter()
        .map(|group| ExternalSourceCheck {
            source_name: group.source_name.clone(),
            count: group
                .skills
                .iter()
                .filter(|skill| !skill.imported || skill.has_update)
                .count(),
        })
        .collect::<Vec<_>>();
    let total_count = sources.iter().map(|source| source.count).sum();
    Ok(ExternalSkillCheckResult {
        has_updates: total_count > 0,
        total_count,
        sources,
    })
}

pub(super) async fn import_external(
    state: &AppState,
    source_name: Option<&str>,
    custom_path: Option<&str>,
    force_overwrite: bool,
    root_path: Option<&str>,
) -> Result<bool, AppError> {
    reject_destructive_overwrite(force_overwrite)?;
    let _guard = EXTERNAL_SKILL_OPERATIONS.lock().await;
    let destination = resolve_destination(state, root_path).await?;
    validate_destination_paths(&destination).await?;
    let sources = resolve_import_sources(state, source_name, custom_path).await?;

    let planning_destination = destination.skills_root.clone();
    let plans = spawn_external_task("prepare external skill import", move || {
        plan_imports_blocking(&sources, &planning_destination, TreeLimits::default())
    })
    .await?;
    if !plans_require_commit(&plans) {
        return Ok(false);
    }

    create_authorized_directory(&destination.authority_root, &destination.skills_root).await?;
    create_authorized_directory(&destination.authority_root, &destination.staging_root).await?;
    let staging_root = destination.staging_root;
    spawn_external_task("commit external skill import", move || {
        commit_imports_blocking(plans, &staging_root, TreeLimits::default())
    })
    .await?;
    Ok(true)
}

pub(super) async fn import_single(
    state: &AppState,
    source_name: &str,
    dir_name: String,
    root_path: Option<&str>,
) -> Result<bool, AppError> {
    let dir_name =
        SafeFileName::parse(dir_name).map_err(|source| AppError::validation(source.to_string()))?;
    let _guard = EXTERNAL_SKILL_OPERATIONS.lock().await;
    let destination = resolve_destination(state, root_path).await?;
    validate_destination_paths(&destination).await?;
    let source = named_default_source(state, source_name)?;
    validate_default_sources(state, std::slice::from_ref(&source)).await?;

    let planning_destination = destination.skills_root.clone();
    let plan = spawn_external_task("prepare external skill import", move || {
        plan_single_import_blocking(
            &source,
            dir_name,
            &planning_destination,
            TreeLimits::default(),
        )
    })
    .await?;
    if plan.disposition == ImportDisposition::Reuse {
        return Ok(false);
    }

    create_authorized_directory(&destination.authority_root, &destination.skills_root).await?;
    create_authorized_directory(&destination.authority_root, &destination.staging_root).await?;
    let staging_root = destination.staging_root;
    spawn_external_task("commit external skill import", move || {
        commit_imports_blocking(vec![plan], &staging_root, TreeLimits::default())
    })
    .await?;
    Ok(true)
}

fn default_sources(state: &AppState) -> Vec<SourceRoot> {
    vec![
        SourceRoot {
            name: CODEX_SOURCE_NAME.to_string(),
            path: state.paths.home_directory().join(".codex/skills"),
            may_be_skill: false,
        },
        SourceRoot {
            name: CLAUDE_SOURCE_NAME.to_string(),
            path: state.paths.home_directory().join(".claude/skills"),
            may_be_skill: false,
        },
    ]
}

fn named_default_source(state: &AppState, source_name: &str) -> Result<SourceRoot, AppError> {
    default_sources(state)
        .into_iter()
        .find(|source| source.name == source_name)
        .ok_or_else(|| AppError::validation("External skill source is invalid"))
}

async fn resolve_import_sources(
    state: &AppState,
    source_name: Option<&str>,
    custom_path: Option<&str>,
) -> Result<Vec<SourceRoot>, AppError> {
    if let Some(custom_path) = custom_path.filter(|path| !path.is_empty()) {
        if source_name.is_some_and(|name| name != CUSTOM_SOURCE_NAME) {
            return Err(AppError::validation(
                "A named external source cannot be combined with a custom path",
            ));
        }
        let path = parse_untrusted_absolute_path(custom_path)?;
        validate_custom_source(&path).await?;
        return Ok(vec![SourceRoot {
            name: CUSTOM_SOURCE_NAME.to_string(),
            path,
            may_be_skill: true,
        }]);
    }

    let sources = match source_name {
        Some(name) => vec![named_default_source(state, name)?],
        None => default_sources(state),
    };
    validate_default_sources(state, &sources).await?;
    Ok(sources)
}

async fn resolve_destination(
    state: &AppState,
    root_path: Option<&str>,
) -> Result<ImportDestination, AppError> {
    let Some(root_path) = root_path.filter(|path| !path.is_empty()) else {
        return Ok(ImportDestination {
            authority_root: state.paths.data_directory().to_path_buf(),
            skills_root: state.paths.data_directory().join("skills"),
            staging_root: state
                .paths
                .data_directory()
                .join(".codez-cache/skill-import-staging"),
        });
    };

    let registered = state.recent_projects.list().await?;
    let workspace = authorize_workspace(root_path, None, &registered).await?;
    workspace_destination(&workspace)
}

fn workspace_destination(workspace: &WorkspaceRoot) -> Result<ImportDestination, AppError> {
    Ok(ImportDestination {
        authority_root: workspace.as_path().to_path_buf(),
        skills_root: workspace_path(workspace, Path::new(".skills"))?,
        staging_root: workspace_path(workspace, Path::new(".codez-cache/skill-import-staging"))?,
    })
}

async fn validate_destination_paths(destination: &ImportDestination) -> Result<(), AppError> {
    ensure_secure_path(&destination.authority_root, &destination.skills_root).await?;
    ensure_secure_path(&destination.authority_root, &destination.staging_root).await
}

async fn validate_default_sources(
    state: &AppState,
    sources: &[SourceRoot],
) -> Result<(), AppError> {
    for source in sources {
        ensure_secure_path(state.paths.home_directory(), &source.path).await?;
    }
    Ok(())
}

async fn validate_custom_source(path: &Path) -> Result<(), AppError> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|source| path_io_error("inspect custom skill source", path, source))?;
    if metadata_is_link_or_reparse(&metadata) {
        return Err(AppError::permission_denied(
            "Custom skill sources must not be symbolic links or reparse points",
        ));
    }
    if !metadata.is_dir() {
        return Err(AppError::validation(
            "Custom skill source must be a directory",
        ));
    }
    let source_path = path.to_path_buf();
    let canonical_path = source_path.clone();
    let canonical = tokio::task::spawn_blocking(move || dunce::canonicalize(&canonical_path))
        .await
        .map_err(|source| AppError::internal(format!("custom source worker failed: {source}")))?
        .map_err(|source| path_io_error("canonicalize custom skill source", path, source))?;
    if !paths_equal(&canonical, &source_path) {
        return Err(AppError::permission_denied(
            "Custom skill sources must not pass through filesystem redirects",
        ));
    }
    Ok(())
}

async fn create_authorized_directory(authority_root: &Path, path: &Path) -> Result<(), AppError> {
    ensure_secure_path(authority_root, path).await?;
    tokio::fs::create_dir_all(path)
        .await
        .map_err(|source| path_io_error("create skill import directory", path, source))?;
    ensure_secure_path(authority_root, path).await?;
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|source| path_io_error("inspect skill import directory", path, source))?;
    if metadata_is_link_or_reparse(&metadata) || !metadata.is_dir() {
        return Err(AppError::permission_denied(
            "Skill import directories must be real directories",
        ));
    }
    Ok(())
}

fn reject_destructive_overwrite(force_overwrite: bool) -> Result<(), AppError> {
    if force_overwrite {
        Err(AppError::validation(
            "External skill imports never overwrite an existing skill; remove the conflict first",
        ))
    } else {
        Ok(())
    }
}

async fn spawn_external_task<T, F>(operation: &'static str, task: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tokio::task::spawn_blocking(task).await.map_err(|source| {
        AppError::internal(format!(
            "{operation} worker failed before completion: {source}"
        ))
    })?
}

fn list_external_blocking(
    sources: &[SourceRoot],
    destination_root: &Path,
    limits: TreeLimits,
) -> Result<Vec<ExternalSkillGroup>, AppError> {
    let mut source_budget = TreeBudget::default();
    let mut destination_budget = TreeBudget::default();
    let mut groups = Vec::with_capacity(sources.len());
    for source in sources {
        let snapshots = discover_source_skills(source, limits, &mut source_budget)?;
        let mut skills = Vec::with_capacity(snapshots.len());
        for snapshot in snapshots {
            let destination = destination_root.join(snapshot.dir_name.as_str());
            let (imported, has_update) = destination_status(
                &destination,
                &snapshot.tree,
                limits,
                &mut destination_budget,
            )?;
            skills.push(ExternalSkillItem {
                dir_name: snapshot.dir_name.as_str().to_string(),
                source_name: source.name.clone(),
                name: snapshot.name,
                description: snapshot.description,
                imported,
                has_update,
            });
        }
        skills.sort_by(|left, right| left.dir_name.cmp(&right.dir_name));
        groups.push(ExternalSkillGroup {
            source_name: source.name.clone(),
            skills,
        });
    }
    Ok(groups)
}

fn plan_imports_blocking(
    sources: &[SourceRoot],
    destination_root: &Path,
    limits: TreeLimits,
) -> Result<Vec<PlannedImport>, AppError> {
    let mut source_budget = TreeBudget::default();
    let mut snapshots = Vec::new();
    let mut names = BTreeSet::new();
    for source in sources {
        for snapshot in discover_source_skills(source, limits, &mut source_budget)? {
            if !names.insert(snapshot.dir_name.as_str().to_string()) {
                return Err(AppError::conflict(
                    "Multiple external sources contain the same skill directory name",
                ));
            }
            snapshots.push(snapshot);
        }
    }
    plan_snapshots(snapshots, destination_root, limits)
}

fn plan_single_import_blocking(
    source: &SourceRoot,
    dir_name: SafeFileName,
    destination_root: &Path,
    limits: TreeLimits,
) -> Result<PlannedImport, AppError> {
    if !source_root_exists(&source.path)? {
        return Err(AppError::not_found("External skill source was not found"));
    }
    let skill_root = source.path.join(dir_name.as_str());
    let metadata = match fs::symlink_metadata(&skill_root) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == io::ErrorKind::NotFound => {
            return Err(AppError::not_found("External skill was not found"));
        }
        Err(source) => return Err(path_io_error("inspect external skill", &skill_root, source)),
    };
    validate_real_directory(&skill_root, &metadata)?;
    let mut budget = TreeBudget::default();
    let snapshot = snapshot_skill(&skill_root, dir_name, limits, &mut budget)?;
    let mut plans = plan_snapshots(vec![snapshot], destination_root, limits)?;
    plans
        .pop()
        .ok_or_else(|| AppError::internal("single external skill plan was empty"))
}

fn plan_snapshots(
    snapshots: Vec<SkillSnapshot>,
    destination_root: &Path,
    limits: TreeLimits,
) -> Result<Vec<PlannedImport>, AppError> {
    let mut destination_budget = TreeBudget::default();
    snapshots
        .into_iter()
        .map(|snapshot| {
            let destination = destination_root.join(snapshot.dir_name.as_str());
            let disposition = match destination_status(
                &destination,
                &snapshot.tree,
                limits,
                &mut destination_budget,
            )? {
                (false, false) => ImportDisposition::Commit,
                (true, false) => ImportDisposition::Reuse,
                (true, true) => {
                    return Err(AppError::conflict(format!(
                        "Skill '{}' already exists with different content",
                        snapshot.dir_name.as_str()
                    )));
                }
                (false, true) => {
                    return Err(AppError::internal(
                        "external skill destination reported an invalid status",
                    ));
                }
            };
            Ok(PlannedImport {
                snapshot,
                destination,
                disposition,
            })
        })
        .collect()
}

fn discover_source_skills(
    source: &SourceRoot,
    limits: TreeLimits,
    budget: &mut TreeBudget,
) -> Result<Vec<SkillSnapshot>, AppError> {
    if !source_root_exists(&source.path)? {
        return Ok(Vec::new());
    }

    let root_document = source.path.join("SKILL.md");
    if source.may_be_skill && path_is_regular_file(&root_document)? {
        let dir_name = source
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| AppError::validation("External skill path must be valid Unicode"))?;
        let dir_name = SafeFileName::parse(dir_name.to_string())
            .map_err(|source| AppError::validation(source.to_string()))?;
        return snapshot_skill(&source.path, dir_name, limits, budget).map(|skill| vec![skill]);
    }

    let entries = read_bounded_directory(&source.path, limits, budget)?;
    let mut snapshots = Vec::new();
    for entry in entries {
        let name = entry
            .file_name()
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| AppError::validation("External skill paths must be valid Unicode"))?;
        let safe_name = SafeFileName::parse(name.clone())
            .map_err(|source| AppError::validation(source.to_string()))?;
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| path_io_error("inspect external skill entry", &path, error))?;
        if metadata_is_link_or_reparse(&metadata) {
            return Err(AppError::permission_denied(
                "Symbolic links and reparse points are not allowed in external skill sources",
            ));
        }
        if !metadata.is_dir() {
            continue;
        }
        if path_is_regular_file(&path.join("SKILL.md"))? {
            snapshots.push(snapshot_skill(&path, safe_name, limits, budget)?);
        }
    }
    Ok(snapshots)
}

fn source_root_exists(path: &Path) -> Result<bool, AppError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            validate_real_directory(path, &metadata)?;
            Ok(true)
        }
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(path_io_error("inspect external skill source", path, source)),
    }
}

fn validate_real_directory(path: &Path, metadata: &fs::Metadata) -> Result<(), AppError> {
    if metadata_is_link_or_reparse(metadata) {
        return Err(AppError::permission_denied(
            "Symbolic links and reparse points are not allowed in external skill sources",
        ));
    }
    if !metadata.is_dir() {
        return Err(AppError::validation(format!(
            "External skill path is not a directory: {}",
            path.display()
        )));
    }
    Ok(())
}

fn path_is_regular_file(path: &Path) -> Result<bool, AppError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata_is_link_or_reparse(&metadata) => Err(AppError::permission_denied(
            "External skill documents must not be links",
        )),
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(AppError::validation(
            "External SKILL.md must be a regular file",
        )),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(path_io_error(
            "inspect external skill document",
            path,
            source,
        )),
    }
}

fn snapshot_skill(
    skill_root: &Path,
    dir_name: SafeFileName,
    limits: TreeLimits,
    budget: &mut TreeBudget,
) -> Result<SkillSnapshot, AppError> {
    let tree = snapshot_tree(skill_root, limits, budget)?;
    let document = tree
        .files
        .iter()
        .find(|file| file.relative_path == Path::new("SKILL.md"))
        .ok_or_else(|| AppError::validation("External skill does not contain SKILL.md"))?;
    let (name, description) = parse_skill_metadata(&document.bytes, dir_name.as_str())?;
    Ok(SkillSnapshot {
        dir_name,
        name,
        description,
        tree,
    })
}

fn snapshot_tree(
    root: &Path,
    limits: TreeLimits,
    budget: &mut TreeBudget,
) -> Result<TreeSnapshot, AppError> {
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|source| path_io_error("inspect skill tree root", root, source))?;
    validate_real_directory(root, &root_metadata)?;
    let mut pending = vec![(root.to_path_buf(), PathBuf::new(), 0_usize)];
    let mut directories = Vec::new();
    let mut files = Vec::new();

    while let Some((directory, relative_directory, depth)) = pending.pop() {
        let entries = read_bounded_directory(&directory, limits, budget)?;
        for entry in entries {
            let name = entry
                .file_name()
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| AppError::validation("Skill paths must be valid Unicode"))?;
            SafeFileName::parse(name.clone())
                .map_err(|source| AppError::validation(source.to_string()))?;
            let path = entry.path();
            let relative_path = relative_directory.join(name);
            let metadata = fs::symlink_metadata(&path)
                .map_err(|source| path_io_error("inspect skill tree entry", &path, source))?;
            if metadata_is_link_or_reparse(&metadata) {
                return Err(AppError::permission_denied(
                    "Symbolic links and reparse points are not allowed in skill trees",
                ));
            }
            if metadata.is_dir() {
                let child_depth = depth.checked_add(1).ok_or_else(|| {
                    AppError::validation("External skill directory nesting is too deep")
                })?;
                if child_depth > limits.max_depth {
                    return Err(AppError::validation(format!(
                        "External skill directory exceeds the depth limit of {}",
                        limits.max_depth
                    )));
                }
                directories.push(relative_path.clone());
                pending.push((path, relative_path, child_depth));
            } else if metadata.is_file() {
                files.push(read_tree_file(
                    &path,
                    relative_path,
                    metadata,
                    limits,
                    budget,
                )?);
            } else {
                return Err(AppError::permission_denied(
                    "External skill trees may contain only regular files and directories",
                ));
            }
        }
    }
    directories.sort();
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(TreeSnapshot { directories, files })
}

fn read_bounded_directory(
    directory: &Path,
    limits: TreeLimits,
    budget: &mut TreeBudget,
) -> Result<Vec<fs::DirEntry>, AppError> {
    let entries = fs::read_dir(directory)
        .map_err(|source| path_io_error("read external skill directory", directory, source))?;
    let mut collected = Vec::new();
    for entry in entries {
        let entry = entry
            .map_err(|source| path_io_error("read external skill entry", directory, source))?;
        budget.account_entry(limits)?;
        collected.push(entry);
    }
    collected.sort_by_key(fs::DirEntry::file_name);
    Ok(collected)
}

fn read_tree_file(
    path: &Path,
    relative_path: PathBuf,
    metadata: fs::Metadata,
    limits: TreeLimits,
    budget: &mut TreeBudget,
) -> Result<TreeFile, AppError> {
    if metadata.len() > limits.max_file_bytes {
        return Err(AppError::validation(format!(
            "External skill file exceeds the {}-byte limit",
            limits.max_file_bytes
        )));
    }
    let expected_identity = Handle::from_path(path)
        .map_err(|source| path_io_error("capture external skill file identity", path, source))?;
    let mut file = File::open(path)
        .map_err(|source| path_io_error("open external skill file", path, source))?;
    let opened_identity = Handle::from_file(
        file.try_clone()
            .map_err(|source| path_io_error("clone external skill file handle", path, source))?,
    )
    .map_err(|source| path_io_error("inspect open external skill file", path, source))?;
    if opened_identity != expected_identity {
        return Err(AppError::permission_denied(
            "External skill files must not change identity while being opened",
        ));
    }
    let opened_metadata = file
        .metadata()
        .map_err(|source| path_io_error("inspect open external skill file", path, source))?;
    if !opened_metadata.is_file() || opened_metadata.len() > limits.max_file_bytes {
        return Err(AppError::permission_denied(
            "External skill files must remain regular files while being read",
        ));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(limits.max_file_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|source| path_io_error("read external skill file", path, source))?;
    let bytes_len = u64::try_from(bytes.len())
        .map_err(|_| AppError::validation("External skill file is too large"))?;
    if bytes_len > limits.max_file_bytes {
        return Err(AppError::validation(format!(
            "External skill file exceeds the {}-byte limit",
            limits.max_file_bytes
        )));
    }
    let final_metadata = fs::symlink_metadata(path)
        .map_err(|source| path_io_error("reinspect external skill file", path, source))?;
    if metadata_is_link_or_reparse(&final_metadata) || !final_metadata.is_file() {
        return Err(AppError::permission_denied(
            "External skill files changed type while being read",
        ));
    }
    let final_identity = Handle::from_path(path)
        .map_err(|source| path_io_error("reopen external skill file identity", path, source))?;
    if final_identity != opened_identity {
        return Err(AppError::permission_denied(
            "External skill files must not change identity while being read",
        ));
    }
    budget.account_bytes(bytes_len, limits)?;
    Ok(TreeFile {
        relative_path,
        bytes,
        permissions: opened_metadata.permissions(),
    })
}

fn parse_skill_metadata(bytes: &[u8], fallback_name: &str) -> Result<(String, String), AppError> {
    let content = std::str::from_utf8(bytes)
        .map_err(|_| AppError::validation("External SKILL.md must be valid UTF-8"))?;
    let frontmatter = extract_frontmatter(content)?;
    let parsed: SkillFrontmatter = serde_yaml::from_str(frontmatter).map_err(|source| {
        AppError::validation(format!(
            "External SKILL.md frontmatter is invalid: {source}"
        ))
    })?;
    let name = parsed
        .name
        .unwrap_or_else(|| fallback_name.to_string())
        .trim()
        .to_string();
    let description = parsed.description.unwrap_or_default().trim().to_string();
    if name.is_empty() || name.len() > MAX_METADATA_NAME_BYTES {
        return Err(AppError::validation(
            "External skill name is empty or too long",
        ));
    }
    if description.len() > MAX_METADATA_DESCRIPTION_BYTES {
        return Err(AppError::validation(
            "External skill description is too long",
        ));
    }
    Ok((name, description))
}

fn extract_frontmatter(content: &str) -> Result<&str, AppError> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = content.split_inclusive('\n');
    let first = lines
        .next()
        .ok_or_else(|| AppError::validation("External SKILL.md is empty"))?;
    if first.trim_end_matches(['\r', '\n']) != "---" {
        return Err(AppError::validation(
            "External SKILL.md is missing YAML frontmatter",
        ));
    }
    let start = first.len();
    let mut offset = start;
    for line in lines {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return Ok(&content[start..offset]);
        }
        offset = offset
            .checked_add(line.len())
            .ok_or_else(|| AppError::validation("External SKILL.md is too large"))?;
    }
    Err(AppError::validation(
        "External SKILL.md frontmatter is not terminated",
    ))
}

fn destination_status(
    destination: &Path,
    source_tree: &TreeSnapshot,
    limits: TreeLimits,
    budget: &mut TreeBudget,
) -> Result<(bool, bool), AppError> {
    let metadata = match fs::symlink_metadata(destination) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok((false, false)),
        Err(source) => {
            return Err(path_io_error(
                "inspect imported skill destination",
                destination,
                source,
            ));
        }
    };
    if metadata_is_link_or_reparse(&metadata) {
        return Err(AppError::permission_denied(
            "Imported skill destinations must not be links or reparse points",
        ));
    }
    if !metadata.is_dir() {
        return Err(AppError::conflict(
            "An imported skill destination exists but is not a directory",
        ));
    }
    let destination_tree = snapshot_tree(destination, limits, budget)?;
    Ok((true, !trees_equal(source_tree, &destination_tree)))
}

fn trees_equal(left: &TreeSnapshot, right: &TreeSnapshot) -> bool {
    left.directories == right.directories
        && left.files.len() == right.files.len()
        && left.files.iter().zip(&right.files).all(|(left, right)| {
            left.relative_path == right.relative_path
                && left.bytes == right.bytes
                && permissions_equal(&left.permissions, &right.permissions)
        })
}

#[cfg(unix)]
fn permissions_equal(left: &fs::Permissions, right: &fs::Permissions) -> bool {
    use std::os::unix::fs::PermissionsExt;

    left.mode() & 0o7777 == right.mode() & 0o7777
}

#[cfg(not(unix))]
fn permissions_equal(left: &fs::Permissions, right: &fs::Permissions) -> bool {
    left.readonly() == right.readonly()
}

fn plans_require_commit(plans: &[PlannedImport]) -> bool {
    plans
        .iter()
        .any(|plan| plan.disposition == ImportDisposition::Commit)
}

fn commit_imports_blocking(
    plans: Vec<PlannedImport>,
    staging_root: &Path,
    limits: TreeLimits,
) -> Result<(), AppError> {
    validate_commit_directory(staging_root, "skill import staging")?;
    for plan in &plans {
        let parent = plan.destination.parent().ok_or_else(|| {
            AppError::validation("External skill destination does not have a parent directory")
        })?;
        validate_commit_directory(parent, "skill destination")?;
    }
    for plan in plans
        .iter()
        .filter(|plan| plan.disposition == ImportDisposition::Reuse)
    {
        verify_reused_import(plan, limits)?;
    }

    #[cfg(not(windows))]
    let (_temporary, staged) = stage_imports(&plans, staging_root)?;
    #[cfg(windows)]
    let staged = BTreeMap::new();

    let mut committed = Vec::new();
    for plan in &plans {
        if plan.disposition == ImportDisposition::Reuse {
            continue;
        }
        let committed_import = match commit_planned_import(plan, &staged, limits) {
            Ok(committed_import) => committed_import,
            Err(error) => {
                return Err(rollback_failure(error, &committed, &plans, limits));
            }
        };
        committed.push(committed_import);
        if let Err(error) = verify_committed_import(plan, committed.last(), limits) {
            return Err(rollback_failure(error, &committed, &plans, limits));
        }
    }
    Ok(())
}

fn rollback_failure(
    error: AppError,
    committed: &[CommittedImport],
    plans: &[PlannedImport],
    limits: TreeLimits,
) -> AppError {
    match rollback_committed(committed, plans, limits) {
        Ok(()) => error,
        Err(rollback) => AppError::storage(
            "External skills could not be imported or rolled back safely",
            format!(
                "import failure: {}; rollback failure: {}",
                error.diagnostic().unwrap_or_else(|| error.public_message()),
                rollback
                    .diagnostic()
                    .unwrap_or_else(|| rollback.public_message())
            ),
            false,
        ),
    }
}

#[cfg(windows)]
fn materialization_rollback_failure(error: AppError, rollback: AppError) -> AppError {
    AppError::storage(
        "External skills could not be imported or rolled back safely",
        format!(
            "import failure: {}; rollback failure: {}",
            error.diagnostic().unwrap_or_else(|| error.public_message()),
            rollback
                .diagnostic()
                .unwrap_or_else(|| rollback.public_message())
        ),
        false,
    )
}

#[cfg(not(windows))]
fn stage_imports(
    plans: &[PlannedImport],
    staging_root: &Path,
) -> Result<(tempfile::TempDir, BTreeMap<String, PathBuf>), AppError> {
    let temporary = Builder::new()
        .prefix(".codez-skill-import-")
        .tempdir_in(staging_root)
        .map_err(|source| {
            path_io_error(
                "create skill import staging directory",
                staging_root,
                source,
            )
        })?;
    let mut staged = BTreeMap::new();
    for plan in plans {
        if plan.disposition == ImportDisposition::Commit {
            let staged_path = temporary.path().join(plan.snapshot.dir_name.as_str());
            write_snapshot(&staged_path, &plan.snapshot.tree)?;
            staged.insert(plan.snapshot.dir_name.as_str().to_string(), staged_path);
        }
    }
    Ok((temporary, staged))
}

fn validate_commit_directory(path: &Path, kind: &str) -> Result<(), AppError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|source| path_io_error("inspect skill commit directory", path, source))?;
    if metadata_is_link_or_reparse(&metadata) || !metadata.is_dir() {
        return Err(AppError::permission_denied(format!(
            "The {kind} must be a real directory"
        )));
    }
    Ok(())
}

fn verify_reused_import(plan: &PlannedImport, limits: TreeLimits) -> Result<(), AppError> {
    let mut budget = TreeBudget::default();
    match destination_status(&plan.destination, &plan.snapshot.tree, limits, &mut budget)? {
        (true, false) => Ok(()),
        _ => Err(AppError::conflict(format!(
            "Skill '{}' changed after import preflight",
            plan.snapshot.dir_name.as_str()
        ))),
    }
}

#[cfg(not(windows))]
fn commit_planned_import(
    plan: &PlannedImport,
    staged: &BTreeMap<String, PathBuf>,
    _limits: TreeLimits,
) -> Result<CommittedImport, AppError> {
    rename_staged_import(plan, staged)?;
    capture_committed_import(plan)
}

#[cfg(windows)]
fn commit_planned_import(
    plan: &PlannedImport,
    _staged: &BTreeMap<String, PathBuf>,
    limits: TreeLimits,
) -> Result<CommittedImport, AppError> {
    let reservation = reserve_destination(plan)?;
    if let Err(error) = materialize_reserved_import(&reservation, &plan.snapshot.tree) {
        return match rollback_reserved_import(&reservation, limits) {
            Ok(()) => Err(error),
            Err(rollback) => Err(materialization_rollback_failure(error, rollback)),
        };
    }
    Ok(reservation.into_committed(plan.snapshot.dir_name.as_str().to_string()))
}

#[cfg(not(windows))]
fn rename_staged_import(
    plan: &PlannedImport,
    staged: &BTreeMap<String, PathBuf>,
) -> Result<(), AppError> {
    let staged_path = staged
        .get(plan.snapshot.dir_name.as_str())
        .ok_or_else(|| AppError::internal("staged skill directory was not found"))?;
    rename_directory_noreplace(staged_path, &plan.destination).map_err(|source| {
        if matches!(source.kind(), io::ErrorKind::AlreadyExists) {
            AppError::conflict("External skill destination already exists")
        } else {
            path_io_error(
                "atomically commit external skill",
                &plan.destination,
                source,
            )
        }
    })
}

#[cfg(not(windows))]
fn capture_committed_import(plan: &PlannedImport) -> Result<CommittedImport, AppError> {
    let parent = plan.destination.parent().ok_or_else(|| {
        AppError::validation("External skill destination does not have a parent directory")
    })?;
    let parent_identity = capture_directory_identity(parent, "skill import parent directory")?;
    let destination_identity =
        capture_directory_identity(&plan.destination, "imported skill destination")?;
    Ok(CommittedImport {
        name: plan.snapshot.dir_name.as_str().to_string(),
        destination_identity,
        parent: parent.to_path_buf(),
        parent_identity,
    })
}

fn capture_directory_identity(path: &Path, kind: &str) -> Result<Handle, AppError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|source| path_io_error("inspect skill commit directory", path, source))?;
    if metadata_is_link_or_reparse(&metadata) || !metadata.is_dir() {
        return Err(AppError::permission_denied(format!(
            "The {kind} must be a real directory"
        )));
    }
    Handle::from_path(path)
        .map_err(|source| path_io_error("capture skill import directory identity", path, source))
}

fn verify_directory_identity(path: &Path, expected: &Handle, kind: &str) -> Result<(), AppError> {
    let observed = capture_directory_identity(path, kind)?;
    if !observed.eq(expected) {
        return Err(AppError::conflict(format!(
            "The {kind} changed while the skill import was in progress"
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn reserve_destination(plan: &PlannedImport) -> Result<ReservedImport, AppError> {
    let parent = plan.destination.parent().ok_or_else(|| {
        AppError::validation("External skill destination does not have a parent directory")
    })?;
    let parent = parent.to_path_buf();
    let parent_identity = capture_directory_identity(&parent, "skill import parent directory")?;
    fs::create_dir(&plan.destination).map_err(|source| {
        if source.kind() == io::ErrorKind::AlreadyExists {
            AppError::conflict(format!(
                "Skill '{}' appeared while the import was being committed",
                plan.snapshot.dir_name.as_str()
            ))
        } else {
            path_io_error(
                "reserve external skill destination",
                &plan.destination,
                source,
            )
        }
    })?;
    let destination_identity =
        capture_directory_identity(&plan.destination, "skill import destination")?;
    let reservation = ReservedImport {
        destination: plan.destination.clone(),
        destination_identity,
        parent,
        parent_identity,
    };
    reservation.verify_identity()?;
    Ok(reservation)
}

#[cfg(windows)]
fn materialize_reserved_import(
    reservation: &ReservedImport,
    snapshot: &TreeSnapshot,
) -> Result<(), AppError> {
    reservation.verify_identity()?;
    write_snapshot_contents(&reservation.destination, snapshot, Some(reservation))?;
    reservation.verify_identity()
}

#[cfg(windows)]
fn rollback_reserved_import(
    reservation: &ReservedImport,
    limits: TreeLimits,
) -> Result<(), AppError> {
    reservation.verify_identity()?;
    let mut budget = TreeBudget::default();
    snapshot_tree(&reservation.destination, limits, &mut budget)?;
    reservation.verify_identity()?;
    fs::remove_dir_all(&reservation.destination).map_err(|source| {
        path_io_error(
            "roll back incomplete external skill import",
            &reservation.destination,
            source,
        )
    })?;
    ensure_destination_absent(&reservation.destination)?;
    sync_directory(&reservation.parent)
}

fn verify_committed_import(
    plan: &PlannedImport,
    committed: Option<&CommittedImport>,
    limits: TreeLimits,
) -> Result<(), AppError> {
    let committed = committed.ok_or_else(|| {
        AppError::internal("committed external skill was absent from import tracking")
    })?;
    committed.verify_identity()?;
    sync_directory(&committed.parent)?;
    committed.verify_identity()?;
    let mut budget = TreeBudget::default();
    let committed_tree = snapshot_tree(&plan.destination, limits, &mut budget)?;
    committed.verify_identity()?;
    if !trees_equal(&plan.snapshot.tree, &committed_tree) {
        return Err(AppError::storage(
            "An external skill failed verification after import",
            format!(
                "committed skill tree differs from staging: {}",
                plan.destination.display()
            ),
            false,
        ));
    }
    Ok(())
}

#[cfg(any(
    target_os = "android",
    target_os = "linux",
    target_os = "macos",
    target_os = "ios",
    target_os = "tvos",
    target_os = "visionos",
    target_os = "watchos"
))]
fn rename_directory_noreplace(source: &Path, destination: &Path) -> io::Result<()> {
    use rustix::fs::{CWD, RenameFlags, renameat_with};

    renameat_with(CWD, source, CWD, destination, RenameFlags::NOREPLACE).map_err(Into::into)
}

#[cfg(not(any(
    target_os = "android",
    target_os = "linux",
    target_os = "macos",
    target_os = "ios",
    target_os = "tvos",
    target_os = "visionos",
    target_os = "watchos",
    windows
)))]
fn rename_directory_noreplace(_source: &Path, _destination: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "atomic no-replace directory rename is unavailable on this platform",
    ))
}

fn rollback_committed(
    committed_imports: &[CommittedImport],
    plans: &[PlannedImport],
    limits: TreeLimits,
) -> Result<(), AppError> {
    for committed in committed_imports.iter().rev() {
        let plan = plans
            .iter()
            .find(|plan| plan.snapshot.dir_name.as_str() == committed.name.as_str())
            .ok_or_else(|| AppError::internal("committed skill was absent from import plan"))?;
        committed.verify_identity()?;
        let mut budget = TreeBudget::default();
        let current = snapshot_tree(&plan.destination, limits, &mut budget)?;
        committed.verify_identity()?;
        if !trees_equal(&plan.snapshot.tree, &current) {
            return Err(AppError::conflict(format!(
                "Imported skill '{}' changed before rollback",
                committed.name
            )));
        }
        fs::remove_dir_all(&plan.destination).map_err(|source| {
            path_io_error(
                "roll back committed external skill",
                &plan.destination,
                source,
            )
        })?;
        ensure_destination_absent(&plan.destination)?;
        sync_directory(&committed.parent)?;
    }
    Ok(())
}

fn ensure_destination_absent(path: &Path) -> Result<(), AppError> {
    match fs::symlink_metadata(path) {
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err(AppError::storage(
            "External skill rollback did not remove its destination",
            format!(
                "skill destination still exists after rollback: {}",
                path.display()
            ),
            false,
        )),
        Err(source) => Err(path_io_error(
            "verify external skill rollback",
            path,
            source,
        )),
    }
}

#[cfg(not(windows))]
fn write_snapshot(destination: &Path, snapshot: &TreeSnapshot) -> Result<(), AppError> {
    fs::create_dir(destination)
        .map_err(|source| path_io_error("create staged skill directory", destination, source))?;
    write_snapshot_contents(destination, snapshot, None)
}

fn write_snapshot_contents(
    destination: &Path,
    snapshot: &TreeSnapshot,
    reservation: Option<&ReservedImport>,
) -> Result<(), AppError> {
    for relative in &snapshot.directories {
        create_snapshot_directory(destination, relative, reservation)?;
    }
    for source_file in snapshot
        .files
        .iter()
        .filter(|source_file| !is_skill_document(source_file))
    {
        write_snapshot_file(destination, source_file, reservation)?;
    }
    // `SKILL.md` makes a directory discoverable, so publish descendants first.
    for document in ordered_skill_documents(snapshot) {
        write_snapshot_file(destination, document, reservation)?;
    }
    for relative in snapshot.directories.iter().rev() {
        sync_directory(&destination.join(relative))?;
    }
    sync_directory(destination)?;
    Ok(())
}

fn create_snapshot_directory(
    destination: &Path,
    relative: &Path,
    reservation: Option<&ReservedImport>,
) -> Result<(), AppError> {
    let path = snapshot_destination_path(destination, relative)?;
    if let Some(reservation) = reservation {
        validate_reserved_parent(reservation, &path)?;
    }
    fs::create_dir(&path)
        .map_err(|source| path_io_error("create staged skill subdirectory", &path, source))?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|source| path_io_error("inspect staged skill subdirectory", &path, source))?;
    if metadata_is_link_or_reparse(&metadata) || !metadata.is_dir() {
        return Err(AppError::permission_denied(
            "Staged skill subdirectories must remain real directories",
        ));
    }
    if let Some(reservation) = reservation {
        reservation.verify_identity()?;
    }
    Ok(())
}

fn write_snapshot_file(
    destination: &Path,
    source_file: &TreeFile,
    reservation: Option<&ReservedImport>,
) -> Result<(), AppError> {
    let path = snapshot_destination_path(destination, &source_file.relative_path)?;
    if let Some(reservation) = reservation {
        validate_reserved_parent(reservation, &path)?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|source| path_io_error("create staged skill file", &path, source))?;
    let opened_identity = Handle::from_file(
        file.try_clone()
            .map_err(|source| path_io_error("clone staged skill file handle", &path, source))?,
    )
    .map_err(|source| path_io_error("inspect staged skill file", &path, source))?;
    file.write_all(&source_file.bytes)
        .map_err(|source| path_io_error("write staged skill file", &path, source))?;
    file.sync_all()
        .map_err(|source| path_io_error("sync staged skill file", &path, source))?;
    fs::set_permissions(&path, source_file.permissions.clone())
        .map_err(|source| path_io_error("preserve staged skill permissions", &path, source))?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|source| path_io_error("reinspect staged skill file", &path, source))?;
    if metadata_is_link_or_reparse(&metadata) || !metadata.is_file() {
        return Err(AppError::permission_denied(
            "Staged skill files must remain regular files while being written",
        ));
    }
    let final_identity = Handle::from_path(&path)
        .map_err(|source| path_io_error("capture staged skill file identity", &path, source))?;
    if final_identity != opened_identity {
        return Err(AppError::conflict(
            "A staged skill file changed identity while it was being written",
        ));
    }
    if let Some(reservation) = reservation {
        reservation.verify_identity()?;
    }
    Ok(())
}

fn snapshot_destination_path(destination: &Path, relative: &Path) -> Result<PathBuf, AppError> {
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(AppError::validation(
                "External skill snapshot contains an invalid relative path",
            ));
        };
        let name = name
            .to_str()
            .ok_or_else(|| AppError::validation("External skill paths must be valid Unicode"))?;
        SafeFileName::parse(name.to_string())
            .map_err(|source| AppError::validation(source.to_string()))?;
    }
    if relative.as_os_str().is_empty() {
        return Err(AppError::validation(
            "External skill snapshot contains an empty relative path",
        ));
    }
    Ok(destination.join(relative))
}

fn validate_reserved_parent(reservation: &ReservedImport, path: &Path) -> Result<(), AppError> {
    reservation.verify_identity()?;
    let parent = path.parent().ok_or_else(|| {
        AppError::validation("External skill snapshot destination does not have a parent directory")
    })?;
    let relative_parent = parent.strip_prefix(&reservation.destination).map_err(|_| {
        AppError::permission_denied("External skill snapshot path escaped its reserved destination")
    })?;
    let mut current = reservation.destination.clone();
    for component in relative_parent.components() {
        let Component::Normal(segment) = component else {
            return Err(AppError::validation(
                "External skill snapshot contains an invalid parent path",
            ));
        };
        current.push(segment);
        let metadata = fs::symlink_metadata(&current).map_err(|source| {
            path_io_error("inspect reserved skill directory", &current, source)
        })?;
        if metadata_is_link_or_reparse(&metadata) || !metadata.is_dir() {
            return Err(AppError::permission_denied(
                "Reserved skill directories must remain real directories",
            ));
        }
    }
    Ok(())
}

fn is_skill_document(file: &TreeFile) -> bool {
    file.relative_path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "SKILL.md")
}

fn ordered_skill_documents(snapshot: &TreeSnapshot) -> Vec<&TreeFile> {
    let mut documents = snapshot
        .files
        .iter()
        .filter(|source_file| is_skill_document(source_file))
        .collect::<Vec<_>>();
    documents.sort_by(|left, right| {
        relative_path_depth(&right.relative_path)
            .cmp(&relative_path_depth(&left.relative_path))
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });
    documents
}

fn relative_path_depth(path: &Path) -> usize {
    path.components().count()
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), AppError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| path_io_error("sync staged skill directory", path, source))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), AppError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    use codez_core::AppErrorKind;

    #[cfg(not(windows))]
    use super::rename_directory_noreplace;
    use super::{
        ImportDestination, SourceRoot, TreeFile, TreeLimits, TreeSnapshot, commit_imports_blocking,
        list_external_blocking, ordered_skill_documents, plan_imports_blocking,
        plan_single_import_blocking, plans_require_commit, reject_destructive_overwrite,
    };
    use crate::commands::path_security::SafeFileName;

    fn fixture_source(root: &Path, name: &str) -> SourceRoot {
        SourceRoot {
            name: name.to_string(),
            path: root.to_path_buf(),
            may_be_skill: false,
        }
    }

    fn fixture_destination(root: &Path) -> ImportDestination {
        ImportDestination {
            authority_root: root.to_path_buf(),
            skills_root: root.join("skills"),
            staging_root: root.join("temp/skill-imports"),
        }
    }

    fn write_skill(root: &Path, dir_name: &str, display_name: &str, body: &str) {
        let directory = root.join(dir_name);
        fs::create_dir_all(directory.join("references"))
            .expect("fixture skill directory must exist");
        fs::write(
            directory.join("SKILL.md"),
            format!(
                "---\nname: '{display_name}'\ndescription: >\n  Unicode fixture description\n---\n{body}\n"
            ),
        )
        .expect("fixture SKILL.md must exist");
        fs::write(directory.join("references/example.txt"), "example")
            .expect("fixture reference must exist");
    }

    #[test]
    fn skill_documents_are_written_from_descendants_to_ancestors() {
        let root = tempfile::tempdir().expect("fixture root must exist");
        let permissions = fs::metadata(root.path())
            .expect("fixture root metadata must exist")
            .permissions();
        let snapshot = TreeSnapshot {
            directories: Vec::new(),
            files: vec![
                TreeFile {
                    relative_path: PathBuf::from("SKILL.md"),
                    bytes: Vec::new(),
                    permissions: permissions.clone(),
                },
                TreeFile {
                    relative_path: PathBuf::from("child/SKILL.md"),
                    bytes: Vec::new(),
                    permissions: permissions.clone(),
                },
                TreeFile {
                    relative_path: PathBuf::from("child/grandchild/SKILL.md"),
                    bytes: Vec::new(),
                    permissions,
                },
            ],
        };

        let documents = ordered_skill_documents(&snapshot)
            .into_iter()
            .map(|file| file.relative_path.clone())
            .collect::<Vec<_>>();

        assert_eq!(
            documents,
            vec![
                PathBuf::from("child/grandchild/SKILL.md"),
                PathBuf::from("child/SKILL.md"),
                PathBuf::from("SKILL.md"),
            ]
        );
    }

    fn import_all(
        sources: &[SourceRoot],
        destination: &ImportDestination,
        limits: TreeLimits,
    ) -> Result<bool, codez_core::AppError> {
        let plans = plan_imports_blocking(sources, &destination.skills_root, limits)?;
        if !plans_require_commit(&plans) {
            return Ok(false);
        }
        fs::create_dir_all(&destination.skills_root)
            .expect("fixture destination directory must exist");
        fs::create_dir_all(&destination.staging_root)
            .expect("fixture staging directory must exist");
        commit_imports_blocking(plans, &destination.staging_root, limits)?;
        Ok(true)
    }

    #[test]
    fn list_and_import_preserve_unicode_frontmatter_and_files() {
        let source = tempfile::tempdir().expect("source root must exist");
        let data = tempfile::tempdir().expect("data root must exist");
        write_skill(source.path(), "代码审查", "代码审查", "审查正文");
        let source = fixture_source(source.path(), "Codex");
        let destination = fixture_destination(data.path());

        let before = list_external_blocking(
            std::slice::from_ref(&source),
            &destination.skills_root,
            TreeLimits::default(),
        )
        .expect("valid Unicode skill must be listed");
        import_all(
            std::slice::from_ref(&source),
            &destination,
            TreeLimits::default(),
        )
        .expect("valid Unicode skill must import");

        assert_eq!(before[0].skills[0].name, "代码审查");
        assert_eq!(
            fs::read_to_string(destination.skills_root.join("代码审查/SKILL.md"))
                .expect("imported Unicode skill must be readable"),
            "---\nname: '代码审查'\ndescription: >\n  Unicode fixture description\n---\n审查正文\n"
        );
    }

    #[test]
    fn identical_reimport_is_idempotent() {
        let source = tempfile::tempdir().expect("source root must exist");
        let data = tempfile::tempdir().expect("data root must exist");
        write_skill(source.path(), "review", "Review", "body");
        let source = fixture_source(source.path(), "Codex");
        let destination = fixture_destination(data.path());

        import_all(
            std::slice::from_ref(&source),
            &destination,
            TreeLimits::default(),
        )
        .expect("first import must succeed");
        let first = fs::read(destination.skills_root.join("review/SKILL.md"))
            .expect("first import must persist");
        let second_result = import_all(
            std::slice::from_ref(&source),
            &destination,
            TreeLimits::default(),
        )
        .expect("identical reimport must succeed without copying data");

        assert!(!second_result);
        assert_eq!(
            fs::read(destination.skills_root.join("review/SKILL.md"))
                .expect("reused import must remain readable"),
            first
        );
    }

    #[test]
    fn permission_changes_are_reported_as_external_skill_updates() {
        let source = tempfile::tempdir().expect("source root must exist");
        let data = tempfile::tempdir().expect("data root must exist");
        write_skill(source.path(), "review", "Review", "body");
        let source = fixture_source(source.path(), "Codex");
        let destination = fixture_destination(data.path());
        import_all(
            std::slice::from_ref(&source),
            &destination,
            TreeLimits::default(),
        )
        .expect("valid skill must import");
        let document = destination.skills_root.join("review/SKILL.md");
        let original = fs::metadata(&document)
            .expect("imported document metadata must exist")
            .permissions();
        let mut changed = original.clone();
        changed.set_readonly(!original.readonly());
        fs::set_permissions(&document, changed).expect("fixture document permissions must change");

        let groups = list_external_blocking(
            std::slice::from_ref(&source),
            &destination.skills_root,
            TreeLimits::default(),
        )
        .expect("permission-only updates must be listed");
        fs::set_permissions(document, original).expect("fixture permissions must be restored");

        assert!(groups[0].skills[0].has_update);
    }

    #[test]
    fn conflicting_destination_is_never_overwritten() {
        let source = tempfile::tempdir().expect("source root must exist");
        let data = tempfile::tempdir().expect("data root must exist");
        write_skill(source.path(), "review", "Review", "new body");
        write_skill(
            &data.path().join("skills"),
            "review",
            "Review",
            "existing body",
        );
        let source = fixture_source(source.path(), "Codex");
        let destination = fixture_destination(data.path());

        let error = import_all(
            std::slice::from_ref(&source),
            &destination,
            TreeLimits::default(),
        )
        .expect_err("different destination content must conflict");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
        assert!(
            fs::read_to_string(destination.skills_root.join("review/SKILL.md"))
                .expect("conflicting destination must remain")
                .contains("existing body")
        );
    }

    #[test]
    fn bulk_preflight_failure_does_not_partially_import_valid_skills() {
        let source = tempfile::tempdir().expect("source root must exist");
        let data = tempfile::tempdir().expect("data root must exist");
        write_skill(source.path(), "a-valid", "Valid", "body");
        let invalid = source.path().join("z-invalid");
        fs::create_dir_all(&invalid).expect("invalid fixture directory must exist");
        fs::write(invalid.join("SKILL.md"), "missing frontmatter")
            .expect("invalid fixture document must exist");
        let source = fixture_source(source.path(), "Codex");
        let destination = fixture_destination(data.path());

        let error = import_all(
            std::slice::from_ref(&source),
            &destination,
            TreeLimits::default(),
        )
        .expect_err("invalid batch member must fail the batch");

        assert_eq!(error.kind(), AppErrorKind::Validation);
        assert!(!destination.skills_root.join("a-valid").exists());
    }

    #[test]
    fn commit_collision_rolls_back_skills_committed_earlier_in_the_batch() {
        let source = tempfile::tempdir().expect("source root must exist");
        let data = tempfile::tempdir().expect("data root must exist");
        write_skill(source.path(), "a-first", "First", "first body");
        write_skill(source.path(), "z-second", "Second", "second body");
        let source = fixture_source(source.path(), "Codex");
        let destination = fixture_destination(data.path());
        let plans = plan_imports_blocking(
            std::slice::from_ref(&source),
            &destination.skills_root,
            TreeLimits::default(),
        )
        .expect("valid batch must pass preflight");
        fs::create_dir_all(&destination.skills_root)
            .expect("fixture destination directory must exist");
        fs::create_dir_all(&destination.staging_root)
            .expect("fixture staging directory must exist");
        fs::create_dir(destination.skills_root.join("z-second"))
            .expect("late conflict fixture must exist");

        let error =
            commit_imports_blocking(plans, &destination.staging_root, TreeLimits::default())
                .expect_err("late conflict must fail the batch");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
        assert!(!destination.skills_root.join("a-first").exists());
        assert!(destination.skills_root.join("z-second").is_dir());
    }

    #[test]
    fn no_replace_commit_preserves_a_destination_created_after_preflight() {
        let source = tempfile::tempdir().expect("source root must exist");
        let data = tempfile::tempdir().expect("data root must exist");
        write_skill(source.path(), "review", "Review", "source body");
        let source = fixture_source(source.path(), "Codex");
        let destination = fixture_destination(data.path());
        let plans = plan_imports_blocking(
            std::slice::from_ref(&source),
            &destination.skills_root,
            TreeLimits::default(),
        )
        .expect("valid skill must pass preflight");
        fs::create_dir_all(&destination.skills_root)
            .expect("fixture destination directory must exist");
        fs::create_dir_all(&destination.staging_root)
            .expect("fixture staging directory must exist");
        let late_destination = destination.skills_root.join("review");
        fs::create_dir(&late_destination).expect("late destination must exist");

        let error =
            commit_imports_blocking(plans, &destination.staging_root, TreeLimits::default())
                .expect_err("atomic no-replace commit must reject a late destination");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
        assert!(late_destination.is_dir());
        assert!(
            fs::read_dir(late_destination)
                .expect("late destination must remain readable")
                .next()
                .is_none()
        );
    }

    #[test]
    fn no_replace_commit_preserves_a_file_created_after_preflight() {
        let source = tempfile::tempdir().expect("source root must exist");
        let data = tempfile::tempdir().expect("data root must exist");
        write_skill(source.path(), "review", "Review", "source body");
        let source = fixture_source(source.path(), "Codex");
        let destination = fixture_destination(data.path());
        let plans = plan_imports_blocking(
            std::slice::from_ref(&source),
            &destination.skills_root,
            TreeLimits::default(),
        )
        .expect("valid skill must pass preflight");
        fs::create_dir_all(&destination.skills_root)
            .expect("fixture destination directory must exist");
        fs::create_dir_all(&destination.staging_root)
            .expect("fixture staging directory must exist");
        let late_destination = destination.skills_root.join("review");
        fs::write(&late_destination, "existing file").expect("late destination file must exist");

        let error =
            commit_imports_blocking(plans, &destination.staging_root, TreeLimits::default())
                .expect_err("no-replace commit must reject a late destination file");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
        assert_eq!(
            fs::read_to_string(late_destination)
                .expect("late destination file must remain readable"),
            "existing file"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn atomic_rename_primitive_never_replaces_an_existing_directory() {
        let root = tempfile::tempdir().expect("fixture root must exist");
        let source = root.path().join("source");
        let destination = root.path().join("destination");
        fs::create_dir(&source).expect("source fixture directory must exist");
        fs::write(source.join("source.txt"), "source").expect("source fixture file must exist");
        fs::create_dir(&destination).expect("destination fixture directory must exist");
        fs::write(destination.join("destination.txt"), "destination")
            .expect("destination fixture file must exist");

        let result = rename_directory_noreplace(&source, &destination);

        assert!(result.is_err());
        assert!(source.join("source.txt").is_file());
        assert_eq!(
            fs::read_to_string(destination.join("destination.txt"))
                .expect("destination fixture must remain readable"),
            "destination"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn atomic_rename_primitive_never_replaces_an_existing_file() {
        let root = tempfile::tempdir().expect("fixture root must exist");
        let source = root.path().join("source");
        let destination = root.path().join("destination");
        fs::create_dir(&source).expect("source fixture directory must exist");
        fs::write(source.join("source.txt"), "source").expect("source fixture file must exist");
        fs::write(&destination, "destination").expect("destination fixture file must exist");

        let result = rename_directory_noreplace(&source, &destination);

        assert!(result.is_err());
        assert!(source.join("source.txt").is_file());
        assert_eq!(
            fs::read_to_string(destination).expect("destination fixture must remain readable"),
            "destination"
        );
    }

    #[test]
    fn reused_import_is_revalidated_before_reporting_success() {
        let source = tempfile::tempdir().expect("source root must exist");
        let data = tempfile::tempdir().expect("data root must exist");
        write_skill(source.path(), "review", "Review", "shared body");
        write_skill(
            &data.path().join("skills"),
            "review",
            "Review",
            "shared body",
        );
        let source = fixture_source(source.path(), "Codex");
        let destination = fixture_destination(data.path());
        let plans = plan_imports_blocking(
            std::slice::from_ref(&source),
            &destination.skills_root,
            TreeLimits::default(),
        )
        .expect("identical destination must be reusable");
        fs::create_dir_all(&destination.staging_root)
            .expect("fixture staging directory must exist");
        fs::write(
            destination.skills_root.join("review/SKILL.md"),
            "---\nname: Review\ndescription: changed\n---\nchanged body\n",
        )
        .expect("fixture destination mutation must succeed");

        let error =
            commit_imports_blocking(plans, &destination.staging_root, TreeLimits::default())
                .expect_err("changed reused destination must conflict");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
        assert!(
            fs::read_to_string(destination.skills_root.join("review/SKILL.md"))
                .expect("mutated destination must remain readable")
                .contains("changed body")
        );
    }

    #[test]
    fn scan_limits_reject_excessive_file_and_total_bytes() {
        let source = tempfile::tempdir().expect("source root must exist");
        let data = tempfile::tempdir().expect("data root must exist");
        write_skill(source.path(), "review", "Review", "body");
        fs::write(source.path().join("review/large.bin"), b"12345")
            .expect("large fixture file must exist");
        let source = fixture_source(source.path(), "Codex");
        let destination = fixture_destination(data.path());
        let limits = TreeLimits {
            max_depth: 8,
            max_entries: 32,
            max_file_bytes: 4,
            max_total_bytes: 64,
        };

        let error = import_all(std::slice::from_ref(&source), &destination, limits)
            .expect_err("oversized file must fail before import");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[test]
    fn scan_limits_apply_to_total_bytes_across_individually_valid_files() {
        let source = tempfile::tempdir().expect("source root must exist");
        let data = tempfile::tempdir().expect("data root must exist");
        write_skill(source.path(), "review", "Review", "body");
        fs::write(source.path().join("review/a.bin"), b"1234")
            .expect("first fixture file must exist");
        fs::write(source.path().join("review/b.bin"), b"5678")
            .expect("second fixture file must exist");
        let document_bytes = fs::metadata(source.path().join("review/SKILL.md"))
            .expect("fixture document metadata must exist")
            .len();
        let reference_bytes = fs::metadata(source.path().join("review/references/example.txt"))
            .expect("fixture reference metadata must exist")
            .len();
        let source = fixture_source(source.path(), "Codex");
        let destination = fixture_destination(data.path());
        let limits = TreeLimits {
            max_depth: 8,
            max_entries: 32,
            max_file_bytes: document_bytes.max(reference_bytes).max(4),
            max_total_bytes: document_bytes + reference_bytes + 7,
        };

        let error = import_all(std::slice::from_ref(&source), &destination, limits)
            .expect_err("aggregate source bytes over the limit must fail");

        assert_eq!(error.kind(), AppErrorKind::Validation);
        assert!(!destination.skills_root.join("review").exists());
    }

    #[test]
    fn scan_limits_reject_entry_count_before_import() {
        let source = tempfile::tempdir().expect("source root must exist");
        let data = tempfile::tempdir().expect("data root must exist");
        for index in 0..4 {
            fs::write(source.path().join(format!("entry-{index}.txt")), "entry")
                .expect("fixture entry must exist");
        }
        let source = fixture_source(source.path(), "Codex");
        let destination = fixture_destination(data.path());
        let limits = TreeLimits {
            max_depth: 8,
            max_entries: 3,
            max_file_bytes: 64,
            max_total_bytes: 64,
        };

        let error = import_all(std::slice::from_ref(&source), &destination, limits)
            .expect_err("entry count over the limit must fail during discovery");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[test]
    fn single_import_rejects_traversal_unc_ads_and_device_names() {
        let values = ["../escape", r"\\server\share", "name:stream", "CON"];

        assert!(
            values
                .into_iter()
                .all(|value| SafeFileName::parse(value).is_err())
        );
    }

    #[test]
    fn single_import_reports_missing_skill_as_not_found() {
        let source = tempfile::tempdir().expect("source root must exist");
        let data = tempfile::tempdir().expect("data root must exist");
        let source = fixture_source(source.path(), "Codex");
        let destination = fixture_destination(data.path());
        let name = SafeFileName::parse("missing").expect("fixture name must be safe");

        let result = plan_single_import_blocking(
            &source,
            name,
            &destination.skills_root,
            TreeLimits::default(),
        );
        let error = match result {
            Ok(_) => panic!("missing skill must not look like a successful false result"),
            Err(error) => error,
        };

        assert_eq!(error.kind(), AppErrorKind::NotFound);
    }

    #[test]
    fn force_overwrite_is_rejected_instead_of_destroying_a_conflict() {
        let error = reject_destructive_overwrite(true)
            .expect_err("destructive overwrite must not be supported");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_rejected_before_import() {
        use std::os::unix::fs::symlink;

        let source = tempfile::tempdir().expect("source root must exist");
        let outside = tempfile::tempdir().expect("outside root must exist");
        let data = tempfile::tempdir().expect("data root must exist");
        write_skill(source.path(), "review", "Review", "body");
        fs::write(outside.path().join("secret"), "outside").expect("outside fixture must exist");
        symlink(
            outside.path().join("secret"),
            source.path().join("review/escape"),
        )
        .expect("fixture symlink must exist");
        let source = fixture_source(source.path(), "Codex");
        let destination = fixture_destination(data.path());

        let error = import_all(
            std::slice::from_ref(&source),
            &destination,
            TreeLimits::default(),
        )
        .expect_err("symlink escape must be rejected");

        assert_eq!(error.kind(), AppErrorKind::PermissionDenied);
        assert!(!destination.skills_root.join("review").exists());
    }
}
