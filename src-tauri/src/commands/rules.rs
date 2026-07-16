use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};

use codez_contracts::CommandError;
use codez_core::{AppError, RecentProjectRepository, WorkspaceRoot};
use codez_storage::AtomicFileStore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{State, command};
use tokio::sync::Mutex;

use super::path_security::{
    SafeFileName, authorize_workspace, ensure_secure_path, parse_untrusted_absolute_path,
    path_io_error, paths_equal, secure_directory_exists, workspace_path,
};
use crate::{error::command_result, state::AppState};

const AGENTS_FILE: &str = "AGENTS.md";
const WORKSPACE_ROOT_RULES: [&str; 3] = [AGENTS_FILE, ".clinerules", ".cursorrules"];

static RULE_MUTATIONS: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum RuleScope {
    Global,
    Workspace,
}

impl RuleScope {
    fn parse(value: &str) -> Result<Self, AppError> {
        match value {
            "global" => Ok(Self::Global),
            "workspace" => Ok(Self::Workspace),
            _ => Err(AppError::validation("Rule scope is invalid")),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuleWorkspaceInput {
    id: String,
    root_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuleSaveInput {
    filename: String,
    scope: RuleScope,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuleFile {
    filename: String,
    scope: RuleScope,
    path: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    globs: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    always_apply: Option<bool>,
    enabled: bool,
}

#[derive(Debug)]
struct AuthorizedWorkspace {
    id: String,
    root: WorkspaceRoot,
}

struct RulesService {
    data_root: PathBuf,
    files: Arc<AtomicFileStore>,
}

impl RulesService {
    fn new(data_root: PathBuf, files: Arc<AtomicFileStore>) -> Self {
        Self { data_root, files }
    }

    async fn list(&self, workspaces: &[AuthorizedWorkspace]) -> Result<Vec<RuleFile>, AppError> {
        let mut rules = Vec::new();
        if let Some(rule) = self
            .read_rule(
                &self.data_root,
                &self.data_root.join(AGENTS_FILE),
                RuleScope::Global,
                None,
            )
            .await?
        {
            rules.push(rule);
        }
        rules.extend(
            self.read_rule_directory(
                &self.data_root,
                &self.data_root.join("rules"),
                RuleScope::Global,
                None,
            )
            .await?,
        );

        for workspace in workspaces {
            let root = workspace.root.as_path();
            for relative in [
                AGENTS_FILE,
                ".agents/AGENTS.md",
                ".clinerules",
                ".cursorrules",
            ] {
                let path = workspace_path(&workspace.root, Path::new(relative))?;
                if let Some(rule) = self
                    .read_rule(
                        root,
                        &path,
                        RuleScope::Workspace,
                        Some(workspace.id.as_str()),
                    )
                    .await?
                {
                    rules.push(rule);
                }
            }
            let directory = workspace_path(&workspace.root, Path::new(".codez/rules"))?;
            rules.extend(
                self.read_rule_directory(
                    root,
                    &directory,
                    RuleScope::Workspace,
                    Some(workspace.id.as_str()),
                )
                .await?,
            );
        }
        Ok(rules)
    }

    async fn save(
        &self,
        rule: RuleSaveInput,
        workspace: Option<&WorkspaceRoot>,
    ) -> Result<bool, AppError> {
        let _guard = RULE_MUTATIONS.lock().await;
        let filename = SafeFileName::parse(rule.filename)
            .map_err(|source| AppError::validation(source.to_string()))?;
        let target = match rule.path.as_deref().filter(|path| !path.is_empty()) {
            Some(path) => {
                let candidate = parse_untrusted_absolute_path(path)?;
                self.authorize_rule_path(&candidate, rule.scope, workspace)
                    .await?;
                let candidate_name = candidate
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| AppError::validation("Rule path has no valid file name"))?;
                if candidate_name != filename.as_str() {
                    return Err(AppError::validation(
                        "Rule file name does not match its authorized path",
                    ));
                }
                candidate
            }
            None => self.new_rule_path(&filename, rule.scope, workspace)?,
        };
        let authority = self.authority_root(rule.scope, workspace)?;
        ensure_secure_path(authority, &target).await?;
        self.files
            .write_bytes(&target, rule.content.as_bytes())
            .await
            .map_err(AppError::from)?;
        Ok(true)
    }

    async fn delete(
        &self,
        untrusted_path: &str,
        workspace_roots: &[WorkspaceRoot],
    ) -> Result<bool, AppError> {
        let _guard = RULE_MUTATIONS.lock().await;
        let path = parse_untrusted_absolute_path(untrusted_path)?;
        let authority = self.authorize_any_rule_path(&path, workspace_roots).await?;
        ensure_secure_path(&authority, &path).await?;
        let removed = self
            .files
            .remove_file(&path)
            .await
            .map_err(AppError::from)?;
        if !removed {
            return Err(AppError::not_found("Rule file was not found"));
        }
        Ok(true)
    }

    async fn rename(
        &self,
        untrusted_old_path: &str,
        new_filename: &str,
        scope: RuleScope,
        workspace: Option<&WorkspaceRoot>,
    ) -> Result<bool, AppError> {
        let _guard = RULE_MUTATIONS.lock().await;
        let old_path = parse_untrusted_absolute_path(untrusted_old_path)?;
        self.authorize_rule_path(&old_path, scope, workspace)
            .await?;
        let filename = SafeFileName::parse(new_filename)
            .map_err(|source| AppError::validation(source.to_string()))?;
        let new_path = self.new_rule_path(&filename, scope, workspace)?;
        if paths_equal(&old_path, &new_path) {
            return Ok(true);
        }

        let authority = self.authority_root(scope, workspace)?;
        ensure_secure_path(authority, &old_path).await?;
        ensure_secure_path(authority, &new_path).await?;
        if self
            .files
            .read_bytes(&new_path)
            .await
            .map_err(AppError::from)?
            .is_some()
        {
            return Err(AppError::conflict(
                "A rule with that file name already exists",
            ));
        }
        let content = self
            .files
            .read_bytes(&old_path)
            .await
            .map_err(AppError::from)?
            .ok_or_else(|| AppError::not_found("Rule file was not found"))?;
        self.files
            .write_bytes(&new_path, &content)
            .await
            .map_err(AppError::from)?;
        let removed = self
            .files
            .remove_file(&old_path)
            .await
            .map_err(AppError::from)?;
        if !removed {
            return Err(AppError::not_found("Rule file was not found"));
        }
        Ok(true)
    }

    async fn read_rule_directory(
        &self,
        authority_root: &Path,
        directory: &Path,
        scope: RuleScope,
        project_id: Option<&str>,
    ) -> Result<Vec<RuleFile>, AppError> {
        if !secure_directory_exists(authority_root, directory).await? {
            return Ok(Vec::new());
        }
        let mut entries = tokio::fs::read_dir(directory)
            .await
            .map_err(|source| path_io_error("read rule directory", directory, source))?;
        let mut paths = Vec::new();
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|source| path_io_error("read rule directory entry", directory, source))?
        {
            let path = entry.path();
            let file_type = entry
                .file_type()
                .await
                .map_err(|source| path_io_error("inspect rule directory entry", &path, source))?;
            if file_type.is_symlink() {
                return Err(AppError::permission_denied(
                    "Symbolic links are not allowed in rule directories",
                ));
            }
            if !file_type.is_file() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                return Err(AppError::validation("Rule file name must be valid Unicode"));
            };
            let safe_name = SafeFileName::parse(name)
                .map_err(|source| AppError::validation(source.to_string()))?;
            if safe_name.as_str().ends_with(".md") {
                paths.push(path);
            }
        }
        paths.sort();

        let mut rules = Vec::with_capacity(paths.len());
        for path in paths {
            if let Some(rule) = self
                .read_rule(authority_root, &path, scope, project_id)
                .await?
            {
                rules.push(rule);
            }
        }
        Ok(rules)
    }

    async fn read_rule(
        &self,
        authority_root: &Path,
        path: &Path,
        scope: RuleScope,
        project_id: Option<&str>,
    ) -> Result<Option<RuleFile>, AppError> {
        ensure_secure_path(authority_root, path).await?;
        let Some(bytes) = self.files.read_bytes(path).await.map_err(AppError::from)? else {
            return Ok(None);
        };
        let content = String::from_utf8(bytes).map_err(|source| {
            AppError::storage(
                "A rule file is not valid UTF-8",
                format!("decode rule file {}: {source}", path.display()),
                false,
            )
        })?;
        let filename = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| AppError::validation("Rule file name must be valid Unicode"))?;
        let filename = SafeFileName::parse(filename.to_string())
            .map_err(|source| AppError::validation(source.to_string()))?;
        Ok(Some(parse_rule_file(
            filename.as_str(),
            path,
            scope,
            content,
            project_id.map(str::to_owned),
        )))
    }

    fn new_rule_path(
        &self,
        filename: &SafeFileName,
        scope: RuleScope,
        workspace: Option<&WorkspaceRoot>,
    ) -> Result<PathBuf, AppError> {
        match scope {
            RuleScope::Global if filename.as_str() == AGENTS_FILE => {
                Ok(self.data_root.join(AGENTS_FILE))
            }
            RuleScope::Global => Ok(self.data_root.join("rules").join(filename.as_str())),
            RuleScope::Workspace => {
                let root = workspace.ok_or_else(|| {
                    AppError::validation("Workspace root is required for workspace rules")
                })?;
                let relative = if WORKSPACE_ROOT_RULES.contains(&filename.as_str()) {
                    PathBuf::from(filename.as_str())
                } else {
                    PathBuf::from(".codez")
                        .join("rules")
                        .join(filename.as_str())
                };
                workspace_path(root, &relative)
            }
        }
    }

    async fn authorize_rule_path(
        &self,
        candidate: &Path,
        scope: RuleScope,
        workspace: Option<&WorkspaceRoot>,
    ) -> Result<(), AppError> {
        let filename = candidate
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| AppError::validation("Rule path has no valid file name"))?;
        let filename = SafeFileName::parse(filename.to_string())
            .map_err(|source| AppError::validation(source.to_string()))?;
        let allowed = match scope {
            RuleScope::Global => self.is_allowed_global_rule_path(candidate, &filename),
            RuleScope::Workspace => {
                let root = workspace.ok_or_else(|| {
                    AppError::validation("Workspace root is required for workspace rules")
                })?;
                self.is_allowed_workspace_rule_path(candidate, root, &filename)?
            }
        };
        if !allowed {
            return Err(AppError::permission_denied(
                "Rule path is outside the authorized rule locations",
            ));
        }
        ensure_secure_path(self.authority_root(scope, workspace)?, candidate).await
    }

    async fn authorize_any_rule_path(
        &self,
        candidate: &Path,
        workspace_roots: &[WorkspaceRoot],
    ) -> Result<PathBuf, AppError> {
        let filename = candidate
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| AppError::validation("Rule path has no valid file name"))?;
        let filename = SafeFileName::parse(filename.to_string())
            .map_err(|source| AppError::validation(source.to_string()))?;
        if self.is_allowed_global_rule_path(candidate, &filename) {
            return Ok(self.data_root.clone());
        }
        for root in workspace_roots {
            if self.is_allowed_workspace_rule_path(candidate, root, &filename)? {
                return Ok(root.as_path().to_path_buf());
            }
        }
        Err(AppError::permission_denied(
            "Rule path is outside the authorized rule locations",
        ))
    }

    fn is_allowed_global_rule_path(&self, candidate: &Path, filename: &SafeFileName) -> bool {
        paths_equal(candidate, &self.data_root.join(AGENTS_FILE))
            || paths_equal(
                candidate,
                &self.data_root.join("rules").join(filename.as_str()),
            )
    }

    fn is_allowed_workspace_rule_path(
        &self,
        candidate: &Path,
        root: &WorkspaceRoot,
        filename: &SafeFileName,
    ) -> Result<bool, AppError> {
        let generic = workspace_path(
            root,
            &PathBuf::from(".codez")
                .join("rules")
                .join(filename.as_str()),
        )?;
        if paths_equal(candidate, &generic) {
            return Ok(true);
        }
        let fixed = [
            AGENTS_FILE,
            ".agents/AGENTS.md",
            ".clinerules",
            ".cursorrules",
        ];
        for relative in fixed {
            if paths_equal(candidate, &workspace_path(root, Path::new(relative))?) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn authority_root<'a>(
        &'a self,
        scope: RuleScope,
        workspace: Option<&'a WorkspaceRoot>,
    ) -> Result<&'a Path, AppError> {
        match scope {
            RuleScope::Global => Ok(&self.data_root),
            RuleScope::Workspace => workspace
                .map(WorkspaceRoot::as_path)
                .ok_or_else(|| AppError::validation("Workspace root is required")),
        }
    }
}

#[command]
pub async fn rules_get_list(
    state: State<'_, AppState>,
    workspaces: Vec<Value>,
) -> Result<Vec<Value>, CommandError> {
    let result = async {
        let registered = state.recent_projects.list().await?;
        let mut authorized = Vec::with_capacity(workspaces.len());
        let mut seen = HashSet::new();
        for value in workspaces {
            let input: RuleWorkspaceInput = serde_json::from_value(value)
                .map_err(|source| AppError::validation(source.to_string()))?;
            let root = authorize_workspace(&input.root_path, Some(&input.id), &registered).await?;
            if seen.insert(root.identity_key()) {
                authorized.push(AuthorizedWorkspace { id: input.id, root });
            }
        }
        let service = RulesService::new(
            state.paths.data_directory().to_path_buf(),
            Arc::clone(&state.storage),
        );
        service
            .list(&authorized)
            .await?
            .into_iter()
            .map(|rule| {
                serde_json::to_value(rule).map_err(|source| AppError::internal(source.to_string()))
            })
            .collect()
    }
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn rules_save(
    state: State<'_, AppState>,
    rule: Value,
    workspace_root: Option<String>,
) -> Result<bool, CommandError> {
    let result = async {
        let rule: RuleSaveInput = serde_json::from_value(rule)
            .map_err(|source| AppError::validation(source.to_string()))?;
        let registered = state.recent_projects.list().await?;
        let workspace = match (rule.scope, workspace_root.as_deref()) {
            (RuleScope::Workspace, Some(root)) if !root.is_empty() => {
                Some(authorize_workspace(root, None, &registered).await?)
            }
            (RuleScope::Workspace, _) => {
                return Err(AppError::validation(
                    "Workspace root is required for workspace rules",
                ));
            }
            (RuleScope::Global, _) => None,
        };
        RulesService::new(
            state.paths.data_directory().to_path_buf(),
            Arc::clone(&state.storage),
        )
        .save(rule, workspace.as_ref())
        .await
    }
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn rules_delete(
    state: State<'_, AppState>,
    rule_path: String,
) -> Result<bool, CommandError> {
    let result = async {
        let registered = state.recent_projects.list().await?;
        let roots: Vec<_> = registered
            .into_iter()
            .map(|project| project.root().clone())
            .collect();
        RulesService::new(
            state.paths.data_directory().to_path_buf(),
            Arc::clone(&state.storage),
        )
        .delete(&rule_path, &roots)
        .await
    }
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn rules_rename(
    state: State<'_, AppState>,
    old_path: String,
    new_filename: String,
    workspace_root: Option<String>,
    scope: String,
) -> Result<bool, CommandError> {
    let result = async {
        let scope = RuleScope::parse(&scope)?;
        let registered = state.recent_projects.list().await?;
        let workspace = match (scope, workspace_root.as_deref()) {
            (RuleScope::Workspace, Some(root)) if !root.is_empty() => {
                Some(authorize_workspace(root, None, &registered).await?)
            }
            (RuleScope::Workspace, _) => {
                return Err(AppError::validation(
                    "Workspace root is required for workspace rules",
                ));
            }
            (RuleScope::Global, _) => None,
        };
        RulesService::new(
            state.paths.data_directory().to_path_buf(),
            Arc::clone(&state.storage),
        )
        .rename(&old_path, &new_filename, scope, workspace.as_ref())
        .await
    }
    .await;
    command_result(&state.errors, result)
}

fn parse_rule_file(
    filename: &str,
    path: &Path,
    scope: RuleScope,
    content: String,
    project_id: Option<String>,
) -> RuleFile {
    let content = content
        .strip_prefix('\u{feff}')
        .map_or_else(|| content.clone(), str::to_owned);
    let mut description = None;
    let mut globs = None;
    let mut always_apply = None;
    let mut enabled = None;
    if let Some(frontmatter) = frontmatter(&content) {
        for line in frontmatter.lines() {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let value = value.trim().trim_matches(['"', '\'']);
            match key.trim() {
                "description" => description = Some(value.to_string()),
                "globs" => globs = Some(value.to_string()),
                "alwaysApply" => always_apply = Some(value == "true"),
                "enabled" => enabled = Some(value == "true"),
                _ => {}
            }
        }
    }
    RuleFile {
        filename: filename.to_string(),
        scope,
        path: path.to_string_lossy().into_owned(),
        content,
        project_id,
        description,
        globs,
        always_apply,
        enabled: enabled.unwrap_or(true),
    }
}

fn frontmatter(content: &str) -> Option<&str> {
    let remainder = content
        .strip_prefix("---\r\n")
        .or_else(|| content.strip_prefix("---\n"))?;
    remainder
        .split_once("\r\n---\r\n")
        .or_else(|| remainder.split_once("\n---\n"))
        .map(|(frontmatter, _)| frontmatter)
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path, sync::Arc};

    use codez_core::{AppErrorKind, WorkspaceRoot};
    use codez_storage::AtomicFileStore;

    use super::{RuleSaveInput, RuleScope, RulesService};

    fn workspace_root(path: &std::path::Path) -> WorkspaceRoot {
        WorkspaceRoot::from_canonical(
            dunce::canonicalize(path).expect("fixture workspace must canonicalize"),
        )
        .expect("fixture workspace must be canonical")
    }

    #[tokio::test]
    async fn rules_save_persists_unicode_rule_atomically_below_codez_data() {
        let data = tempfile::tempdir().expect("data root must exist");
        let service = RulesService::new(
            data.path().to_path_buf(),
            Arc::new(AtomicFileStore::default()),
        );

        service
            .save(
                RuleSaveInput {
                    filename: "审查规则.md".to_string(),
                    scope: RuleScope::Global,
                    path: None,
                    content: "必须先运行测试".to_string(),
                },
                None,
            )
            .await
            .expect("portable Unicode rule must persist");

        assert_eq!(
            fs::read_to_string(data.path().join("rules/审查规则.md"))
                .expect("persisted rule must be readable"),
            "必须先运行测试"
        );
    }

    #[tokio::test]
    async fn rules_save_rejects_path_like_file_names() {
        let data = tempfile::tempdir().expect("data root must exist");
        let service = RulesService::new(
            data.path().to_path_buf(),
            Arc::new(AtomicFileStore::default()),
        );

        let error = service
            .save(
                RuleSaveInput {
                    filename: "../escape.md".to_string(),
                    scope: RuleScope::Global,
                    path: None,
                    content: String::new(),
                },
                None,
            )
            .await
            .expect_err("traversal file names must be rejected");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[tokio::test]
    async fn rules_save_rejects_an_existing_path_outside_its_scope() {
        let data = tempfile::tempdir().expect("data root must exist");
        let outside = tempfile::tempdir().expect("outside root must exist");
        let service = RulesService::new(
            data.path().to_path_buf(),
            Arc::new(AtomicFileStore::default()),
        );

        let error = service
            .save(
                RuleSaveInput {
                    filename: "outside.md".to_string(),
                    scope: RuleScope::Global,
                    path: Some(
                        outside
                            .path()
                            .join("outside.md")
                            .to_string_lossy()
                            .into_owned(),
                    ),
                    content: String::new(),
                },
                None,
            )
            .await
            .expect_err("an out-of-scope absolute path must be rejected");

        assert_eq!(error.kind(), AppErrorKind::PermissionDenied);
    }

    #[tokio::test]
    async fn rules_rename_moves_content_between_authorized_rule_paths() {
        let data = tempfile::tempdir().expect("data root must exist");
        let files = Arc::new(AtomicFileStore::default());
        let service = RulesService::new(data.path().to_path_buf(), Arc::clone(&files));
        let old_path = data.path().join("rules/old.md");
        files
            .write_bytes(&old_path, b"content")
            .await
            .expect("fixture rule must persist");
        service
            .rename(
                &old_path.to_string_lossy(),
                "renamed.md",
                RuleScope::Global,
                None,
            )
            .await
            .expect("authorized rename must succeed");

        assert_eq!(
            (
                old_path.exists(),
                fs::read_to_string(data.path().join("rules/renamed.md"))
                    .expect("renamed rule must be readable")
            ),
            (false, "content".to_string())
        );
    }

    #[tokio::test]
    async fn rules_delete_removes_an_authorized_workspace_rule() {
        let data = tempfile::tempdir().expect("data root must exist");
        let workspace = tempfile::tempdir().expect("workspace must exist");
        fs::create_dir_all(workspace.path().join(".codez/rules"))
            .expect("rule directory must exist");
        let root = workspace_root(workspace.path());
        let rule = super::workspace_path(&root, Path::new(".codez/rules/remove.md"))
            .expect("fixture rule path must remain in its workspace");
        fs::write(&rule, "content").expect("fixture rule must exist");
        let service = RulesService::new(
            data.path().to_path_buf(),
            Arc::new(AtomicFileStore::default()),
        );

        service
            .delete(&rule.to_string_lossy(), &[root])
            .await
            .expect("authorized workspace rule must be deleted");

        assert!(!rule.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rules_save_rejects_a_symlinked_rules_directory() {
        use std::os::unix::fs::symlink;

        let data = tempfile::tempdir().expect("data root must exist");
        let outside = tempfile::tempdir().expect("outside root must exist");
        symlink(outside.path(), data.path().join("rules"))
            .expect("fixture symlink must be created");
        let service = RulesService::new(
            data.path().to_path_buf(),
            Arc::new(AtomicFileStore::default()),
        );

        let error = service
            .save(
                RuleSaveInput {
                    filename: "escape.md".to_string(),
                    scope: RuleScope::Global,
                    path: None,
                    content: "blocked".to_string(),
                },
                None,
            )
            .await
            .expect_err("symlinked rule directories must be rejected");

        assert_eq!(error.kind(), AppErrorKind::PermissionDenied);
    }
}
