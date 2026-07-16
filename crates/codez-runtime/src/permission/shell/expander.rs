use std::collections::HashSet;
use std::path::{Path, PathBuf};
use sha2::{Sha256, Digest};
use tokio::fs;

use crate::permission::shell::types::{PermissionShellKind, PermissionSnapshot};

pub struct ExpandedCommand {
    pub command: Option<String>,
    pub shell: Option<PermissionShellKind>,
    pub snapshots: Vec<PermissionSnapshot>,
    pub opaque_reason: Option<String>,
    pub kind: Option<String>, // "wrapper" | "script"
    pub cwd: Option<String>,
}

async fn snapshot(file_path: &str, content: &str) -> PermissionSnapshot {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    PermissionSnapshot {
        path: file_path.to_string(),
        sha256: hex::encode(hasher.finalize()),
    }
}

pub struct NestedCommandExpander;

impl NestedCommandExpander {
    pub async fn expand_command(
        parent_shell: PermissionShellKind,
        argv: &[String],
        workspace_root: &str,
        cwd: &str,
        depth: usize,
        mut seen: HashSet<String>,
    ) -> ExpandedCommand {
        if depth > 4 {
            return ExpandedCommand {
                command: None,
                shell: None,
                snapshots: vec![],
                opaque_reason: Some("nested-depth".to_string()),
                kind: None,
                cwd: None,
            };
        }

        let raw_executable = argv.get(0).cloned().unwrap_or_default();
        let executable = raw_executable.to_lowercase();
        
        let is_npm = ["npm", "pnpm", "yarn", "bun"].contains(&executable.as_str());

        if is_npm {
            let mut command_index = 1;
            let mut package_root = cwd.to_string();
            
            if let Some(directory_option) = argv.get(1) {
                let accepts_dir = (executable == "npm" && directory_option == "--prefix")
                    || (executable == "pnpm" && ["-C", "--dir"].contains(&directory_option.as_str()))
                    || (["yarn", "bun"].contains(&executable.as_str()) && directory_option == "--cwd");
                
                if accepts_dir {
                    if let Some(dir) = argv.get(2) {
                        package_root = Path::new(cwd).join(dir).to_string_lossy().to_string();
                        command_index = 3;
                    } else {
                        return ExpandedCommand {
                            command: None, shell: None, snapshots: vec![], opaque_reason: Some("missing-package-root".to_string()), kind: None, cwd: None
                        };
                    }
                }
            }

            let raw_subcommand = argv.get(command_index).cloned().unwrap_or_default();
            let subcommand = raw_subcommand.to_lowercase();

            let builtins = ["install", "add", "update", "run", "run-script"]; // simplified
            if builtins.contains(&subcommand.as_str()) && subcommand != "run" {
                return ExpandedCommand { command: None, shell: None, snapshots: vec![], opaque_reason: None, kind: None, cwd: None };
            }

            let script_name = if subcommand == "run" {
                argv.get(command_index + 1).cloned()
            } else {
                Some(raw_subcommand)
            };

            if let Some(name) = script_name {
                let package_path = Path::new(&package_root).join("package.json");
                if let Ok(content) = fs::read_to_string(&package_path).await {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                        if let Some(scripts) = json.get("scripts") {
                            if let Some(script_cmd) = scripts.get(&name).and_then(|v| v.as_str()) {
                                return ExpandedCommand {
                                    command: Some(script_cmd.to_string()),
                                    shell: Some(parent_shell),
                                    snapshots: vec![snapshot(&package_path.to_string_lossy(), &content).await],
                                    opaque_reason: None,
                                    kind: Some("script".to_string()),
                                    cwd: Some(package_root),
                                };
                            }
                        }
                    }
                }
            }
        }

        ExpandedCommand {
            command: None,
            shell: None,
            snapshots: vec![],
            opaque_reason: None,
            kind: None,
            cwd: None,
        }
    }
}
