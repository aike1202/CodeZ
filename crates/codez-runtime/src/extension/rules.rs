use std::path::Path;
use tokio::fs;

pub struct RulesLoader;

impl RulesLoader {
    pub async fn load_rules(root: &Path) -> Result<String, String> {
        let rules_path = root.join("AGENTS.md");
        if !rules_path.exists() {
            return Ok(String::new());
        }

        let content = fs::read_to_string(rules_path).await.map_err(|e| e.to_string())?;
        Ok(content)
    }

    pub async fn load_and_merge_rules(global_root: &Path, workspace_root: &Path) -> String {
        let mut rules = String::new();

        if let Ok(global_rules) = Self::load_rules(global_root).await {
            if !global_rules.is_empty() {
                rules.push_str(&global_rules);
                rules.push('\n');
            }
        }

        if let Ok(ws_rules) = Self::load_rules(workspace_root).await {
            if !ws_rules.is_empty() {
                rules.push_str(&ws_rules);
            }
        }

        rules
    }
}
