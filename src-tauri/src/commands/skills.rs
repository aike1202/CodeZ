use std::{
    collections::{BTreeMap, VecDeque},
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
};

use codez_contracts::CommandError;
use codez_core::{AppError, RecentProjectRepository, WorkspaceRoot};
use codez_storage::AtomicFileStore;
use serde::Serialize;
use serde_json::Value;
use tauri::{State, command};
use thiserror::Error;
use tokio::sync::Mutex;

use super::external_skills::{self, ExternalSkillCheckResult, ExternalSkillGroup};
use super::path_security::{
    SafeFileName, authorize_workspace, ensure_secure_path, path_io_error, secure_directory_exists,
    workspace_path,
};
use crate::{error::command_result, state::AppState};

const MAX_SKILL_TREE_DEPTH: usize = 16;
const MAX_SKILL_TREE_ENTRIES: usize = 4_096;

static SKILL_CONFIG_MUTATIONS: Mutex<()> = Mutex::const_new(());

type SkillConfig = BTreeMap<String, bool>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SkillScope {
    Builtin,
    Global,
    Workspace,
}

impl SkillScope {
    const fn id_prefix(self) -> &'static str {
        match self {
            Self::Builtin => "builtin-",
            Self::Global => "global-",
            Self::Workspace => "workspace-",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SkillId {
    scope: SkillScope,
    bare_name: SafeFileName,
}

impl SkillId {
    fn parse(value: &str) -> Result<Self, AppError> {
        let (scope, bare_name) = if let Some(name) = value.strip_prefix("builtin-") {
            (SkillScope::Builtin, name)
        } else if let Some(name) = value.strip_prefix("global-") {
            (SkillScope::Global, name)
        } else if let Some(name) = value.strip_prefix("workspace-") {
            (SkillScope::Workspace, name)
        } else {
            return Err(AppError::validation(
                "Skill identifier has an invalid scope",
            ));
        };
        let bare_name = SafeFileName::parse(bare_name.to_string())
            .map_err(|source| AppError::validation(source.to_string()))?;
        Ok(Self { scope, bare_name })
    }

    fn value(&self) -> String {
        format!("{}{}", self.scope.id_prefix(), self.bare_name.as_str())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillDefinition {
    id: String,
    name: String,
    description: String,
    triggers: Vec<String>,
    content: String,
    path: String,
    enabled: bool,
    is_global: bool,
    builtin: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemovalKind {
    File,
    Directory,
}

#[derive(Debug)]
struct SkillCandidate {
    id: SkillId,
    document_path: PathBuf,
    removal_path: PathBuf,
    removal_kind: RemovalKind,
}

#[derive(Debug)]
struct ParsedSkillDocument {
    name: Option<String>,
    description: Option<String>,
    triggers: Vec<String>,
    content: String,
}

#[derive(Debug, Error)]
enum SkillDirectoryRemovalError {
    #[error("skill directory contains a symbolic link: {0}")]
    SymbolicLink(PathBuf),
    #[error("skill directory contains too many entries")]
    TooManyEntries,
    #[error("failed to inspect or remove skill directory {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

struct SkillsService {
    data_root: PathBuf,
    resource_root: PathBuf,
    builtin_skills_root: PathBuf,
    files: Arc<AtomicFileStore>,
}

impl SkillsService {
    fn new(
        data_root: PathBuf,
        resource_root: PathBuf,
        builtin_skills_root: PathBuf,
        files: Arc<AtomicFileStore>,
    ) -> Self {
        Self {
            data_root,
            resource_root,
            builtin_skills_root,
            files,
        }
    }

    async fn list(
        &self,
        workspace: Option<&WorkspaceRoot>,
    ) -> Result<Vec<SkillDefinition>, AppError> {
        let global_config = self.load_config(SkillScope::Global, None).await?;
        let workspace_config = match workspace {
            Some(root) => self.load_config(SkillScope::Workspace, Some(root)).await?,
            None => SkillConfig::new(),
        };
        let mut definitions = Vec::new();
        definitions.extend(
            self.load_scope(
                &self.resource_root,
                &self.builtin_skills_root,
                SkillScope::Builtin,
                &global_config,
            )
            .await?,
        );
        definitions.extend(
            self.load_scope(
                &self.data_root,
                &self.data_root.join("skills"),
                SkillScope::Global,
                &global_config,
            )
            .await?,
        );
        if let Some(root) = workspace {
            let skills_root = workspace_path(root, Path::new(".skills"))?;
            definitions.extend(
                self.load_scope(
                    root.as_path(),
                    &skills_root,
                    SkillScope::Workspace,
                    &workspace_config,
                )
                .await?,
            );
        }
        Ok(definitions)
    }

    async fn toggle(
        &self,
        id: &SkillId,
        workspace: Option<&WorkspaceRoot>,
        enabled: bool,
    ) -> Result<(), AppError> {
        let _guard = SKILL_CONFIG_MUTATIONS.lock().await;
        let mut config = self.load_config(id.scope, workspace).await?;
        config.insert(id.value(), enabled);
        self.save_config(id.scope, workspace, &config).await
    }

    async fn remove(
        &self,
        id: &SkillId,
        workspace: Option<&WorkspaceRoot>,
    ) -> Result<bool, AppError> {
        if id.scope == SkillScope::Builtin {
            return Ok(false);
        }
        let (authority_root, skills_root) = match id.scope {
            SkillScope::Global => (self.data_root.as_path(), self.data_root.join("skills")),
            SkillScope::Workspace => {
                let root = workspace.ok_or_else(|| {
                    AppError::validation("Workspace root is required for workspace skills")
                })?;
                (root.as_path(), workspace_path(root, Path::new(".skills"))?)
            }
            SkillScope::Builtin => return Ok(false),
        };
        let candidates = self
            .discover_candidates(authority_root, &skills_root, id.scope)
            .await?;
        let mut matches = candidates
            .into_iter()
            .filter(|candidate| candidate.id == *id);
        let Some(candidate) = matches.next() else {
            return Ok(false);
        };
        if matches.next().is_some() {
            return Err(AppError::conflict(
                "More than one skill has the requested identifier",
            ));
        }

        let _guard = SKILL_CONFIG_MUTATIONS.lock().await;
        let mut config = self.load_config(id.scope, workspace).await?;
        ensure_secure_path(authority_root, &candidate.removal_path).await?;
        match candidate.removal_kind {
            RemovalKind::File => {
                let removed = self
                    .files
                    .remove_file(&candidate.removal_path)
                    .await
                    .map_err(AppError::from)?;
                if !removed {
                    return Err(AppError::not_found("Skill file was not found"));
                }
            }
            RemovalKind::Directory => {
                remove_skill_directory(candidate.removal_path).await?;
            }
        }

        if config.remove(&id.value()).is_some() {
            self.save_config(id.scope, workspace, &config).await?;
        }
        Ok(true)
    }

    async fn load_scope(
        &self,
        authority_root: &Path,
        skills_root: &Path,
        scope: SkillScope,
        config: &SkillConfig,
    ) -> Result<Vec<SkillDefinition>, AppError> {
        let candidates = self
            .discover_candidates(authority_root, skills_root, scope)
            .await?;
        let mut definitions = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            ensure_secure_path(authority_root, &candidate.document_path).await?;
            let Some(bytes) = self
                .files
                .read_bytes(&candidate.document_path)
                .await
                .map_err(AppError::from)?
            else {
                continue;
            };
            let content = String::from_utf8(bytes).map_err(|source| {
                AppError::storage(
                    "A skill file is not valid UTF-8",
                    format!(
                        "decode skill file {}: {source}",
                        candidate.document_path.display()
                    ),
                    false,
                )
            })?;
            let Some(document) = parse_skill_document(&content) else {
                continue;
            };
            let id = candidate.id.value();
            definitions.push(SkillDefinition {
                name: document.name.unwrap_or_else(|| id.clone()),
                description: document.description.unwrap_or_default(),
                triggers: document.triggers,
                content: document.content,
                path: candidate.document_path.to_string_lossy().into_owned(),
                enabled: config.get(&id).copied().unwrap_or(true),
                is_global: scope != SkillScope::Workspace,
                builtin: scope == SkillScope::Builtin,
                id,
            });
        }
        Ok(definitions)
    }

    async fn discover_candidates(
        &self,
        authority_root: &Path,
        skills_root: &Path,
        scope: SkillScope,
    ) -> Result<Vec<SkillCandidate>, AppError> {
        if !secure_directory_exists(authority_root, skills_root).await? {
            return Ok(Vec::new());
        }
        let mut directories = VecDeque::from([(skills_root.to_path_buf(), 0_usize)]);
        let mut candidates = Vec::new();
        let mut entry_count = 0_usize;
        while let Some((directory, depth)) = directories.pop_front() {
            let mut entries = tokio::fs::read_dir(&directory)
                .await
                .map_err(|source| path_io_error("read skills directory", &directory, source))?;
            while let Some(entry) = entries
                .next_entry()
                .await
                .map_err(|source| path_io_error("read skill directory entry", &directory, source))?
            {
                entry_count += 1;
                if entry_count > MAX_SKILL_TREE_ENTRIES {
                    return Err(AppError::validation(
                        "Skill directory contains too many entries",
                    ));
                }
                let path = entry.path();
                let file_type = entry
                    .file_type()
                    .await
                    .map_err(|source| path_io_error("inspect skill entry", &path, source))?;
                if file_type.is_symlink() {
                    return Err(AppError::permission_denied(
                        "Symbolic links are not allowed in skill directories",
                    ));
                }
                let name = entry
                    .file_name()
                    .to_str()
                    .map(str::to_owned)
                    .ok_or_else(|| AppError::validation("Skill paths must be valid Unicode"))?;
                if file_type.is_dir() {
                    let safe_name = SafeFileName::parse(name)
                        .map_err(|source| AppError::validation(source.to_string()))?;
                    let document_path = path.join("SKILL.md");
                    match tokio::fs::symlink_metadata(&document_path).await {
                        Ok(metadata) if metadata.file_type().is_symlink() => {
                            return Err(AppError::permission_denied(
                                "Skill documents must not be symbolic links",
                            ));
                        }
                        Ok(metadata) if metadata.is_file() => {
                            candidates.push(SkillCandidate {
                                id: SkillId {
                                    scope,
                                    bare_name: safe_name,
                                },
                                document_path,
                                removal_path: path.clone(),
                                removal_kind: RemovalKind::Directory,
                            });
                        }
                        Ok(_) => {
                            return Err(AppError::storage(
                                "The local skill data is invalid",
                                format!(
                                    "SKILL.md is not a regular file: {}",
                                    document_path.display()
                                ),
                                false,
                            ));
                        }
                        Err(source) if source.kind() == io::ErrorKind::NotFound => {}
                        Err(source) => {
                            return Err(path_io_error(
                                "inspect skill document",
                                &document_path,
                                source,
                            ));
                        }
                    }
                    if depth >= MAX_SKILL_TREE_DEPTH {
                        return Err(AppError::validation("Skill directory nesting is too deep"));
                    }
                    directories.push_back((path, depth + 1));
                } else if file_type.is_file() && name.ends_with(".skill.md") {
                    let bare_name = name
                        .strip_suffix(".skill.md")
                        .ok_or_else(|| AppError::validation("Skill file name is invalid"))?;
                    let bare_name = SafeFileName::parse(bare_name.to_string())
                        .map_err(|source| AppError::validation(source.to_string()))?;
                    candidates.push(SkillCandidate {
                        id: SkillId { scope, bare_name },
                        document_path: path.clone(),
                        removal_path: path,
                        removal_kind: RemovalKind::File,
                    });
                }
            }
        }
        candidates.sort_by(|left, right| left.document_path.cmp(&right.document_path));
        Ok(candidates)
    }

    async fn load_config(
        &self,
        scope: SkillScope,
        workspace: Option<&WorkspaceRoot>,
    ) -> Result<SkillConfig, AppError> {
        let (authority, path) = self.config_path(scope, workspace)?;
        ensure_secure_path(authority, &path).await?;
        let config = self
            .files
            .read_json::<SkillConfig>(&path)
            .await
            .map_err(AppError::from)?
            .unwrap_or_default();
        for id in config.keys() {
            SkillId::parse(id)?;
        }
        Ok(config)
    }

    async fn save_config(
        &self,
        scope: SkillScope,
        workspace: Option<&WorkspaceRoot>,
        config: &SkillConfig,
    ) -> Result<(), AppError> {
        let (authority, path) = self.config_path(scope, workspace)?;
        ensure_secure_path(authority, &path).await?;
        self.files
            .write_json(&path, config)
            .await
            .map_err(AppError::from)
    }

    fn config_path<'a>(
        &'a self,
        scope: SkillScope,
        workspace: Option<&'a WorkspaceRoot>,
    ) -> Result<(&'a Path, PathBuf), AppError> {
        match scope {
            SkillScope::Builtin | SkillScope::Global => {
                Ok((&self.data_root, self.data_root.join("skills-config.json")))
            }
            SkillScope::Workspace => {
                let root = workspace.ok_or_else(|| {
                    AppError::validation("Workspace root is required for workspace skills")
                })?;
                Ok((
                    root.as_path(),
                    workspace_path(root, Path::new(".codez-cache/skills-config.json"))?,
                ))
            }
        }
    }
}

#[command]
pub async fn skill_get_all(
    state: State<'_, AppState>,
    root_path: Option<String>,
) -> Result<Vec<Value>, CommandError> {
    let result = async {
        let workspace = authorize_optional_workspace(&state, root_path.as_deref()).await?;
        skills_service(&state)
            .list(workspace.as_ref())
            .await?
            .into_iter()
            .map(|skill| {
                serde_json::to_value(skill).map_err(|source| AppError::internal(source.to_string()))
            })
            .collect()
    }
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn skill_toggle(
    state: State<'_, AppState>,
    root_path: Option<String>,
    id: String,
    enabled: bool,
) -> Result<(), CommandError> {
    let result = async {
        let id = SkillId::parse(&id)?;
        let workspace = if id.scope == SkillScope::Workspace {
            Some(
                authorize_optional_workspace(&state, root_path.as_deref())
                    .await?
                    .ok_or_else(|| {
                        AppError::validation("Workspace root is required for workspace skills")
                    })?,
            )
        } else {
            None
        };
        skills_service(&state)
            .toggle(&id, workspace.as_ref(), enabled)
            .await
    }
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn skill_check_external(
    state: State<'_, AppState>,
    root_path: Option<String>,
) -> Result<ExternalSkillCheckResult, CommandError> {
    let result = external_skills::check_external(&state, root_path.as_deref()).await;
    command_result(&state.errors, result)
}

#[command]
pub async fn skill_import_external(
    state: State<'_, AppState>,
    source_name: Option<String>,
    custom_path: Option<String>,
    force_overwrite: Option<bool>,
    root_path: Option<String>,
) -> Result<bool, CommandError> {
    let result = external_skills::import_external(
        &state,
        source_name.as_deref(),
        custom_path.as_deref(),
        force_overwrite.unwrap_or(false),
        root_path.as_deref(),
    )
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn skill_list_external(
    state: State<'_, AppState>,
    root_path: Option<String>,
) -> Result<Vec<ExternalSkillGroup>, CommandError> {
    let result = external_skills::list_external(&state, root_path.as_deref()).await;
    command_result(&state.errors, result)
}

#[command]
pub async fn skill_import_single(
    state: State<'_, AppState>,
    source_name: String,
    dir_name: String,
    root_path: Option<String>,
) -> Result<bool, CommandError> {
    let result =
        external_skills::import_single(&state, &source_name, dir_name, root_path.as_deref()).await;
    command_result(&state.errors, result)
}

#[command]
pub async fn skill_remove(
    state: State<'_, AppState>,
    root_path: Option<String>,
    id: String,
) -> Result<bool, CommandError> {
    let result = async {
        let id = SkillId::parse(&id)?;
        let workspace = if id.scope == SkillScope::Workspace {
            Some(
                authorize_optional_workspace(&state, root_path.as_deref())
                    .await?
                    .ok_or_else(|| {
                        AppError::validation("Workspace root is required for workspace skills")
                    })?,
            )
        } else {
            None
        };
        skills_service(&state).remove(&id, workspace.as_ref()).await
    }
    .await;
    command_result(&state.errors, result)
}

fn skills_service(state: &AppState) -> SkillsService {
    SkillsService::new(
        state.paths.data_directory().to_path_buf(),
        state.resources.root().to_path_buf(),
        state.resources.builtin_skills_directory(),
        Arc::clone(&state.storage),
    )
}

async fn authorize_optional_workspace(
    state: &AppState,
    root_path: Option<&str>,
) -> Result<Option<WorkspaceRoot>, AppError> {
    let Some(root_path) = root_path.filter(|path| !path.is_empty()) else {
        return Ok(None);
    };
    let registered = state.recent_projects.list().await?;
    authorize_workspace(root_path, None, &registered)
        .await
        .map(Some)
}

fn parse_skill_document(content: &str) -> Option<ParsedSkillDocument> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let remainder = content
        .strip_prefix("---\r\n")
        .or_else(|| content.strip_prefix("---\n"))?;
    let (frontmatter, body) = remainder
        .split_once("\r\n---\r\n")
        .or_else(|| remainder.split_once("\n---\n"))?;
    let mut name = None;
    let mut description = None;
    let mut triggers = Vec::new();
    for line in frontmatter.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "name" => name = Some(trim_yaml_scalar(value).to_string()),
            "description" => description = Some(trim_yaml_scalar(value).to_string()),
            "triggers" => {
                let list = value
                    .strip_prefix('[')
                    .and_then(|value| value.strip_suffix(']'))
                    .unwrap_or(value);
                triggers = list
                    .split(',')
                    .map(str::trim)
                    .map(trim_yaml_scalar)
                    .filter(|trigger| !trigger.is_empty())
                    .map(str::to_string)
                    .collect();
            }
            _ => {}
        }
    }
    Some(ParsedSkillDocument {
        name,
        description,
        triggers,
        content: body.trim().to_string(),
    })
}

fn trim_yaml_scalar(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(value)
}

async fn remove_skill_directory(path: PathBuf) -> Result<(), AppError> {
    let diagnostic_path = path.clone();
    tokio::task::spawn_blocking(move || remove_skill_directory_blocking(&path))
        .await
        .map_err(|source| {
            AppError::internal(format!(
                "skill directory removal worker failed for {}: {source}",
                diagnostic_path.display()
            ))
        })?
        .map_err(|source| {
            AppError::storage(
                "The local skill could not be removed safely",
                source.to_string(),
                false,
            )
        })
}

fn remove_skill_directory_blocking(path: &Path) -> Result<(), SkillDirectoryRemovalError> {
    let mut directories = vec![path.to_path_buf()];
    let mut entry_count = 0_usize;
    while let Some(directory) = directories.pop() {
        let metadata =
            fs::symlink_metadata(&directory).map_err(|source| SkillDirectoryRemovalError::Io {
                path: directory.clone(),
                source,
            })?;
        if metadata.file_type().is_symlink() {
            return Err(SkillDirectoryRemovalError::SymbolicLink(directory));
        }
        let entries =
            fs::read_dir(&directory).map_err(|source| SkillDirectoryRemovalError::Io {
                path: directory.clone(),
                source,
            })?;
        for entry in entries {
            let entry = entry.map_err(|source| SkillDirectoryRemovalError::Io {
                path: directory.clone(),
                source,
            })?;
            entry_count += 1;
            if entry_count > MAX_SKILL_TREE_ENTRIES {
                return Err(SkillDirectoryRemovalError::TooManyEntries);
            }
            let child = entry.path();
            let file_type = entry
                .file_type()
                .map_err(|source| SkillDirectoryRemovalError::Io {
                    path: child.clone(),
                    source,
                })?;
            if file_type.is_symlink() {
                return Err(SkillDirectoryRemovalError::SymbolicLink(child));
            }
            if file_type.is_dir() {
                directories.push(child);
            }
        }
    }
    fs::remove_dir_all(path).map_err(|source| SkillDirectoryRemovalError::Io {
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path, sync::Arc};

    use codez_core::{AppErrorKind, WorkspaceRoot};
    use codez_storage::AtomicFileStore;

    use super::{SkillId, SkillScope, SkillsService};

    fn service(data_root: &Path, resource_root: &Path) -> SkillsService {
        SkillsService::new(
            data_root.to_path_buf(),
            resource_root.to_path_buf(),
            resource_root.join("builtin-skills"),
            Arc::new(AtomicFileStore::default()),
        )
    }

    fn create_skill(root: &Path, name: &str, display_name: &str) {
        let directory = root.join(name);
        fs::create_dir_all(&directory).expect("fixture skill directory must exist");
        fs::write(
            directory.join("SKILL.md"),
            format!(
                "---\nname: {display_name}\ndescription: fixture\ntriggers: [test, 审查]\n---\nSkill body"
            ),
        )
        .expect("fixture skill document must exist");
    }

    fn workspace_root(path: &Path) -> WorkspaceRoot {
        WorkspaceRoot::from_canonical(
            fs::canonicalize(path).expect("fixture workspace must canonicalize"),
        )
        .expect("fixture workspace must be canonical")
    }

    #[tokio::test]
    async fn skill_list_restores_builtin_global_and_workspace_contract_fields() {
        let data = tempfile::tempdir().expect("data root must exist");
        let resources = tempfile::tempdir().expect("resource root must exist");
        let workspace = tempfile::tempdir().expect("workspace root must exist");
        create_skill(&resources.path().join("builtin-skills"), "review", "Review");
        create_skill(&data.path().join("skills"), "全局技能", "全局技能");
        create_skill(&workspace.path().join(".skills"), "project", "Project");
        let service = service(data.path(), resources.path());
        let root = workspace_root(workspace.path());

        let skills = service
            .list(Some(&root))
            .await
            .expect("valid skill trees must load");

        assert_eq!(skills.len(), 3);
        assert!(
            skills
                .iter()
                .any(|skill| { skill.id == "builtin-review" && skill.builtin && skill.is_global })
        );
        assert!(skills.iter().any(|skill| {
            skill.id == "global-全局技能"
                && skill.content == "Skill body"
                && skill.triggers == ["test", "审查"]
        }));
        assert!(skills.iter().any(|skill| {
            skill.id == "workspace-project" && !skill.builtin && !skill.is_global
        }));
    }

    #[tokio::test]
    async fn skill_toggle_persists_global_config_with_atomic_store() {
        let data = tempfile::tempdir().expect("data root must exist");
        let resources = tempfile::tempdir().expect("resource root must exist");
        fs::create_dir(resources.path().join("builtin-skills")).expect("builtin root must exist");
        let service = service(data.path(), resources.path());
        let id = SkillId::parse("global-review").expect("fixture id must be valid");

        service
            .toggle(&id, None, false)
            .await
            .expect("valid toggle must persist");

        let config: serde_json::Value = serde_json::from_slice(
            &fs::read(data.path().join("skills-config.json")).expect("skills config must exist"),
        )
        .expect("skills config must be JSON");
        assert_eq!(config["global-review"], false);
    }

    #[tokio::test]
    async fn skill_remove_deletes_only_the_matching_global_skill() {
        let data = tempfile::tempdir().expect("data root must exist");
        let resources = tempfile::tempdir().expect("resource root must exist");
        fs::create_dir(resources.path().join("builtin-skills")).expect("builtin root must exist");
        create_skill(&data.path().join("skills"), "remove-me", "Remove");
        create_skill(&data.path().join("skills"), "keep-me", "Keep");
        let service = service(data.path(), resources.path());
        let id = SkillId::parse("global-remove-me").expect("fixture id must be valid");

        service
            .remove(&id, None)
            .await
            .expect("valid skill removal must succeed");

        assert!(
            !data.path().join("skills/remove-me").exists()
                && data.path().join("skills/keep-me/SKILL.md").is_file()
        );
    }

    #[test]
    fn skill_identifiers_reject_path_and_windows_special_inputs() {
        let candidates = [
            "global-../escape",
            r"workspace-C:\escape",
            r"global-\\server\share",
            "global-name:stream",
            "global-CON",
        ];

        assert!(
            candidates
                .into_iter()
                .all(|candidate| SkillId::parse(candidate).is_err())
        );
    }

    #[tokio::test]
    async fn workspace_skill_operations_require_a_workspace_authority() {
        let data = tempfile::tempdir().expect("data root must exist");
        let resources = tempfile::tempdir().expect("resource root must exist");
        fs::create_dir(resources.path().join("builtin-skills")).expect("builtin root must exist");
        let service = service(data.path(), resources.path());
        let id = SkillId::parse("workspace-review").expect("fixture id must be valid");

        let error = service
            .toggle(&id, None, false)
            .await
            .expect_err("workspace config without an authority must fail");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[test]
    fn skill_id_scope_parser_preserves_valid_unicode_names() {
        let id = SkillId::parse("global-审查技能").expect("Unicode skill id must be valid");

        assert_eq!(
            (id.scope, id.bare_name.as_str()),
            (SkillScope::Global, "审查技能")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn skill_list_rejects_symlinked_skill_documents() {
        use std::os::unix::fs::symlink;

        let data = tempfile::tempdir().expect("data root must exist");
        let resources = tempfile::tempdir().expect("resource root must exist");
        fs::create_dir(resources.path().join("builtin-skills")).expect("builtin root must exist");
        let outside = tempfile::NamedTempFile::new().expect("outside file must exist");
        let skill = data.path().join("skills/linked");
        fs::create_dir_all(&skill).expect("skill directory must exist");
        symlink(outside.path(), skill.join("SKILL.md")).expect("fixture symlink must be created");
        let service = service(data.path(), resources.path());

        let error = service
            .list(None)
            .await
            .expect_err("symlinked skill documents must fail safely");

        assert_eq!(error.kind(), AppErrorKind::PermissionDenied);
    }
}
