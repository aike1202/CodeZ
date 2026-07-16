use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use tokio::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillMetadata {
    pub name: String,
    pub description: String,
}

pub struct SkillLoader;

impl SkillLoader {
    pub async fn load_skill(skill_dir: &Path) -> Result<SkillMetadata, String> {
        let skill_md_path = skill_dir.join("SKILL.md");
        if !skill_md_path.exists() {
            return Err("SKILL.md not found in directory".to_string());
        }

        let content = fs::read_to_string(skill_md_path).await.map_err(|e| e.to_string())?;
        Self::parse_frontmatter(&content)
    }

    fn parse_frontmatter(content: &str) -> Result<SkillMetadata, String> {
        let lines: Vec<&str> = content.lines().collect();
        if lines.is_empty() || lines[0] != "---" {
            return Err("Missing frontmatter opening".to_string());
        }

        let mut name = None;
        let mut description = None;

        for line in lines.iter().skip(1) {
            if *line == "---" {
                break;
            }
            if let Some(stripped) = line.strip_prefix("name:") {
                name = Some(stripped.trim().replace("\"", "").replace("'", ""));
            }
            if let Some(stripped) = line.strip_prefix("description:") {
                description = Some(stripped.trim().replace("\"", "").replace("'", ""));
            }
        }

        match (name, description) {
            (Some(n), Some(d)) => Ok(SkillMetadata { name: n, description: d }),
            _ => Err("Frontmatter missing name or description".to_string()),
        }
    }
}
