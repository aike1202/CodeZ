use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs::{self, OpenOptions};
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;
use serde::{Deserialize, Serialize};

use crate::permission::contract::{PermissionAction, PermissionCapability, PermissionApprovalScope};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRule {
    pub workspace: String,
    pub session_id: Option<String>,
    pub permission: Option<PermissionCapability>,
    pub pattern: String,
    pub action: PermissionAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RulesDocument {
    pub rules: Vec<StoredRule>,
}

pub struct RememberPermissionRuleInput {
    pub workspace_root: String,
    pub session_id: Option<String>,
    pub permission: PermissionCapability,
    pub pattern: String,
    pub action: PermissionAction,
    pub scope: PermissionApprovalScope,
    pub hardline: bool,
}

pub fn normalize_workspace_key(workspace: &str) -> String {
    // In TS this canonicalizes the path to hash or normalized string.
    // Assuming simple lowercase for now or sha256.
    workspace.to_lowercase()
}

pub fn match_permission_pattern(pattern: &str, rule: &str) -> bool {
    if rule == "*" {
        return true;
    }
    if rule.ends_with("/*") {
        let prefix = &rule[..rule.len() - 2];
        return pattern.starts_with(prefix) && (pattern.len() == prefix.len() || pattern[prefix.len()..].starts_with('/') || pattern[prefix.len()..].starts_with('\\'));
    }
    pattern == rule
}

#[derive(Clone)]
pub struct PermissionRuleStore {
    file_path: Option<PathBuf>,
    session_rules: Arc<RwLock<Vec<StoredRule>>>,
}

impl PermissionRuleStore {
    pub fn new(file_path: Option<PathBuf>) -> Self {
        Self {
            file_path,
            session_rules: Arc::new(RwLock::new(Vec::new())),
        }
    }

    async fn workspace_rules(&self) -> Vec<StoredRule> {
        let path = match &self.file_path {
            Some(p) => p,
            None => return vec![],
        };
        match fs::read_to_string(path).await {
            Ok(content) => {
                if let Ok(doc) = serde_json::from_str::<RulesDocument>(&content) {
                    doc.rules
                } else {
                    vec![]
                }
            }
            Err(_) => vec![],
        }
    }

    pub async fn remember(&self, input: RememberPermissionRuleInput) -> Result<(), String> {
        if input.action == PermissionAction::Allow && (input.hardline || input.permission == PermissionCapability::Hardline) {
            return Err("Hardline approvals cannot be persisted".to_string());
        }

        let rule = StoredRule {
            workspace: normalize_workspace_key(&input.workspace_root),
            session_id: if input.scope == PermissionApprovalScope::Session { input.session_id } else { None },
            permission: Some(input.permission),
            pattern: input.pattern.clone(),
            action: input.action.clone(),
        };

        let same_rule = |item: &StoredRule| {
            item.workspace == rule.workspace
                && item.session_id == rule.session_id
                && item.permission.as_ref().unwrap_or(&PermissionCapability::Shell) == rule.permission.as_ref().unwrap()
                && item.pattern == rule.pattern
        };

        if input.scope == PermissionApprovalScope::Session || self.file_path.is_none() {
            let mut mem_rules = self.session_rules.write().await;
            mem_rules.retain(|r| !same_rule(r));
            mem_rules.push(rule);
            return Ok(());
        }

        let mut rules = self.workspace_rules().await;
        rules.retain(|r| !same_rule(r));
        rules.push(rule);

        let path = self.file_path.as_ref().unwrap();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }

        let doc = RulesDocument { rules };
        let json = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
        fs::write(path, json).await.map_err(|e| e.to_string())?;

        Ok(())
    }

    pub async fn resolve(
        &self,
        workspace_root: &str,
        session_id: Option<&str>,
        permission: &PermissionCapability,
        pattern: &str,
    ) -> Option<PermissionAction> {
        let workspace = normalize_workspace_key(workspace_root);
        let ws_rules = self.workspace_rules().await;
        let mem_rules = self.session_rules.read().await;

        let mut candidates = Vec::new();
        for rule in ws_rules.iter().filter(|r| r.session_id.is_none()) {
            candidates.push(rule.clone());
        }
        for rule in mem_rules.iter().filter(|r| r.session_id.is_none()) {
            candidates.push(rule.clone());
        }
        for rule in mem_rules.iter().filter(|r| r.session_id.as_deref() == session_id) {
            candidates.push(rule.clone());
        }

        let mut last_action = None;
        for rule in candidates {
            if rule.workspace == workspace 
                && rule.permission.as_ref().unwrap_or(&PermissionCapability::Shell) == permission
                && match_permission_pattern(pattern, &rule.pattern)
            {
                last_action = Some(rule.action.clone());
            }
        }
        
        last_action
    }
}
