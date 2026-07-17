use std::path::{Path, PathBuf};
use std::sync::Arc;

use codez_core::{AppError, AtomicPersistence};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use thiserror::Error;
use tokio::sync::{Mutex, RwLock};

use crate::permission::contract::{
    PermissionAction, PermissionApprovalScope, PermissionCapability,
};
use crate::permission::decision::PermissionMode;

const RULES_SCHEMA_VERSION: u16 = 1;
const MODES_SCHEMA_VERSION: u16 = 1;

#[derive(Debug, Error)]
pub enum PermissionStoreError {
    #[error("the CodeZ data root must be an absolute path")]
    InvalidDataRoot,
    #[error("permission rules require an existing workspace directory")]
    InvalidWorkspace,
    #[error("a once-only approval cannot be persisted")]
    InvalidApprovalScope,
    #[error("a hardline allow rule cannot be persisted")]
    PersistentHardlineAllow,
    #[error("a permission rule pattern cannot be empty")]
    EmptyPattern,
    #[error("the persisted permission document has an unsupported schema")]
    UnsupportedSchema,
    #[error("the persisted permission document is invalid: {path}")]
    InvalidDocument {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("the permission document could not be serialized: {path}")]
    Serialize {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error(transparent)]
    Persistence(#[from] AppError),
}

impl From<PermissionStoreError> for AppError {
    fn from(error: PermissionStoreError) -> Self {
        match error {
            PermissionStoreError::Persistence(source) => source,
            error @ (PermissionStoreError::InvalidDataRoot
            | PermissionStoreError::InvalidWorkspace
            | PermissionStoreError::InvalidApprovalScope
            | PermissionStoreError::PersistentHardlineAllow
            | PermissionStoreError::EmptyPattern) => AppError::validation(error.to_string()),
            error @ (PermissionStoreError::UnsupportedSchema
            | PermissionStoreError::InvalidDocument { .. }
            | PermissionStoreError::Serialize { .. }) => AppError::storage(
                "Permission settings could not be loaded or saved safely",
                error.to_string(),
                false,
            ),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRule {
    workspace: String,
    session_id: Option<String>,
    permission: Option<PermissionCapability>,
    pattern: String,
    action: PermissionAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
// Electron stored the same payload without schema metadata; explicit metadata is validated below.
struct RulesDocument {
    #[serde(default = "permission_rules_schema")]
    schema: String,
    #[serde(default = "permission_rules_schema_version")]
    schema_version: u16,
    rules: Vec<StoredRule>,
}

impl Default for RulesDocument {
    fn default() -> Self {
        Self {
            schema: permission_rules_schema(),
            schema_version: permission_rules_schema_version(),
            rules: Vec::new(),
        }
    }
}

fn permission_rules_schema() -> String {
    "permission-rules".to_string()
}

const fn permission_rules_schema_version() -> u16 {
    RULES_SCHEMA_VERSION
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
// Electron stored the same payload without schema metadata; explicit metadata is validated below.
struct WorkspaceModesDocument {
    #[serde(default = "workspace_modes_schema")]
    schema: String,
    #[serde(default = "workspace_modes_schema_version")]
    schema_version: u16,
    workspaces: std::collections::BTreeMap<String, PermissionMode>,
}

impl Default for WorkspaceModesDocument {
    fn default() -> Self {
        Self {
            schema: workspace_modes_schema(),
            schema_version: workspace_modes_schema_version(),
            workspaces: std::collections::BTreeMap::new(),
        }
    }
}

fn workspace_modes_schema() -> String {
    "workspace-permissions".to_string()
}

const fn workspace_modes_schema_version() -> u16 {
    MODES_SCHEMA_VERSION
}

#[derive(Debug, Clone)]
pub struct RememberPermissionRuleInput {
    pub workspace_root: PathBuf,
    pub session_id: Option<String>,
    pub permission: PermissionCapability,
    pub pattern: String,
    pub action: PermissionAction,
    pub scope: PermissionApprovalScope,
    pub hardline: bool,
}

/// Produces the stable key used by persisted workspace permission documents.
pub async fn normalize_workspace_key(workspace: &Path) -> Result<String, PermissionStoreError> {
    let canonical = tokio::fs::canonicalize(workspace)
        .await
        .map_err(|_| PermissionStoreError::InvalidWorkspace)?;
    if !canonical.is_dir() {
        return Err(PermissionStoreError::InvalidWorkspace);
    }
    let normalized = canonical.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    let normalized = normalized.to_lowercase();
    Ok(normalized)
}

#[must_use]
pub fn match_permission_pattern(pattern: &str, rule: &str) -> bool {
    if rule == "*" {
        return true;
    }
    if let Some(prefix) = rule.strip_suffix("/*") {
        return pattern == prefix
            || pattern
                .strip_prefix(prefix)
                .is_some_and(|suffix| suffix.starts_with('/') || suffix.starts_with('\\'));
    }
    pattern == rule
}

#[derive(Clone)]
pub struct PermissionRuleStore {
    file_path: PathBuf,
    persistence: Arc<dyn AtomicPersistence>,
    session_rules: Arc<RwLock<Vec<StoredRule>>>,
    mutation: Arc<Mutex<()>>,
}

impl PermissionRuleStore {
    pub fn new(
        data_root: &Path,
        persistence: Arc<dyn AtomicPersistence>,
    ) -> Result<Self, PermissionStoreError> {
        validate_data_root(data_root)?;
        Ok(Self {
            file_path: data_root.join("permission-rules.json"),
            persistence,
            session_rules: Arc::new(RwLock::new(Vec::new())),
            mutation: Arc::new(Mutex::new(())),
        })
    }

    async fn workspace_rules(&self) -> Result<Vec<StoredRule>, PermissionStoreError> {
        let document = read_document::<RulesDocument>(self.persistence.as_ref(), &self.file_path)
            .await?
            .unwrap_or_default();
        if document.schema != "permission-rules" || document.schema_version != RULES_SCHEMA_VERSION
        {
            return Err(PermissionStoreError::UnsupportedSchema);
        }
        Ok(document.rules)
    }

    pub async fn remember(
        &self,
        input: RememberPermissionRuleInput,
    ) -> Result<(), PermissionStoreError> {
        if input.scope == PermissionApprovalScope::Once {
            return Err(PermissionStoreError::InvalidApprovalScope);
        }
        if input.pattern.trim().is_empty() {
            return Err(PermissionStoreError::EmptyPattern);
        }
        if input.action == PermissionAction::Allow
            && (input.hardline || input.permission == PermissionCapability::Hardline)
        {
            return Err(PermissionStoreError::PersistentHardlineAllow);
        }
        let workspace = normalize_workspace_key(&input.workspace_root).await?;
        let rule = StoredRule {
            workspace,
            session_id: if input.scope == PermissionApprovalScope::Session {
                input.session_id
            } else {
                None
            },
            permission: Some(input.permission),
            pattern: input.pattern,
            action: input.action,
        };
        if input.scope == PermissionApprovalScope::Session {
            let mut rules = self.session_rules.write().await;
            replace_rule(&mut rules, rule);
            return Ok(());
        }

        let _guard = self.mutation.lock().await;
        let mut rules = self.workspace_rules().await?;
        replace_rule(&mut rules, rule);
        let document = RulesDocument {
            schema: "permission-rules".to_string(),
            schema_version: RULES_SCHEMA_VERSION,
            rules,
        };
        let bytes = serialize_document(&self.file_path, &document)?;
        self.persistence.replace(&self.file_path, &bytes).await?;
        Ok(())
    }

    pub async fn resolve(
        &self,
        workspace_root: &Path,
        session_id: Option<&str>,
        permission: &PermissionCapability,
        pattern: &str,
    ) -> Result<Option<PermissionAction>, PermissionStoreError> {
        let workspace = normalize_workspace_key(workspace_root).await?;
        let persisted = self.workspace_rules().await?;
        let memory = self.session_rules.read().await;
        let action = persisted
            .iter()
            .filter(|rule| rule.session_id.is_none())
            .chain(memory.iter().filter(|rule| rule.session_id.is_none()))
            .chain(
                memory
                    .iter()
                    .filter(|rule| rule.session_id.as_deref() == session_id),
            )
            .filter(|rule| {
                rule.workspace == workspace
                    && rule
                        .permission
                        .as_ref()
                        .unwrap_or(&PermissionCapability::Shell)
                        == permission
                    && match_permission_pattern(pattern, &rule.pattern)
            })
            .map(|rule| rule.action.clone())
            .next_back();
        Ok(action)
    }

    pub async fn clear_session(&self, session_id: &str) {
        self.session_rules
            .write()
            .await
            .retain(|rule| rule.session_id.as_deref() != Some(session_id));
    }
}

#[derive(Clone)]
pub struct WorkspacePermissionStore {
    file_path: PathBuf,
    persistence: Arc<dyn AtomicPersistence>,
    mutation: Arc<Mutex<()>>,
}

impl WorkspacePermissionStore {
    pub fn new(
        data_root: &Path,
        persistence: Arc<dyn AtomicPersistence>,
    ) -> Result<Self, PermissionStoreError> {
        validate_data_root(data_root)?;
        Ok(Self {
            file_path: data_root.join("workspace-permissions.json"),
            persistence,
            mutation: Arc::new(Mutex::new(())),
        })
    }

    async fn read(&self) -> Result<WorkspaceModesDocument, PermissionStoreError> {
        let document =
            read_document::<WorkspaceModesDocument>(self.persistence.as_ref(), &self.file_path)
                .await?
                .unwrap_or_default();
        if document.schema != "workspace-permissions"
            || document.schema_version != MODES_SCHEMA_VERSION
        {
            return Err(PermissionStoreError::UnsupportedSchema);
        }
        Ok(document)
    }

    pub async fn get_mode(
        &self,
        workspace_root: &Path,
    ) -> Result<PermissionMode, PermissionStoreError> {
        let key = normalize_workspace_key(workspace_root).await?;
        Ok(self
            .read()
            .await?
            .workspaces
            .get(&key)
            .cloned()
            .unwrap_or_default())
    }

    pub async fn set_mode(
        &self,
        workspace_root: &Path,
        mode: PermissionMode,
    ) -> Result<PermissionMode, PermissionStoreError> {
        let key = normalize_workspace_key(workspace_root).await?;
        let _guard = self.mutation.lock().await;
        let mut document = self.read().await?;
        document.workspaces.insert(key, mode.clone());
        let bytes = serialize_document(&self.file_path, &document)?;
        self.persistence.replace(&self.file_path, &bytes).await?;
        Ok(mode)
    }
}

async fn read_document<T>(
    persistence: &dyn AtomicPersistence,
    path: &Path,
) -> Result<Option<T>, PermissionStoreError>
where
    T: DeserializeOwned,
{
    let Some(bytes) = persistence.read(path).await? else {
        return Ok(None);
    };
    serde_json::from_slice(&bytes).map(Some).map_err(|source| {
        PermissionStoreError::InvalidDocument {
            path: path.to_path_buf(),
            source,
        }
    })
}

fn serialize_document<T>(path: &Path, value: &T) -> Result<Vec<u8>, PermissionStoreError>
where
    T: Serialize + ?Sized,
{
    serde_json::to_vec_pretty(value).map_err(|source| PermissionStoreError::Serialize {
        path: path.to_path_buf(),
        source,
    })
}

fn replace_rule(rules: &mut Vec<StoredRule>, replacement: StoredRule) {
    rules.retain(|rule| {
        !(rule.workspace == replacement.workspace
            && rule.session_id == replacement.session_id
            && rule.permission == replacement.permission
            && rule.pattern == replacement.pattern)
    });
    rules.push(replacement);
}

fn validate_data_root(data_root: &Path) -> Result<(), PermissionStoreError> {
    if data_root.is_absolute() {
        Ok(())
    } else {
        Err(PermissionStoreError::InvalidDataRoot)
    }
}
