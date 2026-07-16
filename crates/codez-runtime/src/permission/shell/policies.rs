use crate::permission::contract::{PermissionCapability, PermissionRiskLevel};

pub struct CommandAssessment {
    pub permission: PermissionCapability,
    pub risk_level: PermissionRiskLevel,
    pub rule_id: String,
    pub reason: String,
}

fn normalize_executable_name(exec: &str) -> String {
    // Strip `.exe`, `.cmd`, etc.
    let lower = exec.to_lowercase();
    if lower.ends_with(".exe") || lower.ends_with(".cmd") || lower.ends_with(".bat") {
        lower[..lower.len() - 4].to_string()
    } else {
        lower
    }
}

pub fn classify_known_command(argv: &[String]) -> Option<CommandAssessment> {
    if argv.is_empty() {
        return None;
    }
    let executable = normalize_executable_name(&argv[0]);
    let subcommand = argv.get(1).map(|s| s.to_lowercase()).unwrap_or_default();
    let args: Vec<String> = argv.iter().skip(1).map(|a| a.to_lowercase()).collect();

    let read_commands = ["ls", "dir", "pwd", "which", "where", "cat", "head", "tail", "grep", "rg", "findstr", "get-content", "get-childitem", "get-location", "test-path"];
    if read_commands.contains(&executable.as_str()) {
        return Some(CommandAssessment {
            permission: PermissionCapability::Shell,
            risk_level: 0,
            rule_id: format!("known.read.{}", executable),
            reason: "只读查询命令".to_string(),
        });
    }

    if executable == "git" {
        if ["status", "diff", "log", "show", "branch", "rev-parse"].contains(&subcommand.as_str()) {
            return Some(CommandAssessment {
                permission: PermissionCapability::Shell,
                risk_level: 0,
                rule_id: format!("known.git.{}", subcommand),
                reason: "只读 Git 操作".to_string(),
            });
        }
        if subcommand == "push" && args.iter().any(|a| a.contains("force")) {
            return Some(CommandAssessment {
                permission: PermissionCapability::Hardline,
                risk_level: 4,
                rule_id: "critical.git.force-push".to_string(),
                reason: "强制改写远端历史".to_string(),
            });
        }
        if ["push", "fetch", "pull", "clone"].contains(&subcommand.as_str()) {
            return Some(CommandAssessment {
                permission: PermissionCapability::Network,
                risk_level: 2,
                rule_id: format!("known.git.{}.network", subcommand),
                reason: "访问远端 Git 仓库".to_string(),
            });
        }
        return Some(CommandAssessment {
            permission: PermissionCapability::Shell,
            risk_level: 1,
            rule_id: format!("known.git.{}", if subcommand.is_empty() { "write" } else { &subcommand }),
            reason: "修改工作区 Git 状态".to_string(),
        });
    }

    if ["npm", "pnpm", "yarn", "bun"].contains(&executable.as_str()) {
        if ["install", "add", "update", "ci", "remove", "uninstall"].contains(&subcommand.as_str()) {
            return Some(CommandAssessment {
                permission: PermissionCapability::Network,
                risk_level: 2,
                rule_id: format!("known.package.{}.{}", executable, subcommand),
                reason: "修改包或访问包服务".to_string(),
            });
        }
        return Some(CommandAssessment {
            permission: PermissionCapability::Shell,
            risk_level: 1,
            rule_id: format!("known.package.{}.script", executable),
            reason: "运行工作区开发命令".to_string(),
        });
    }

    if ["python", "python3", "py"].contains(&executable.as_str()) {
        return Some(CommandAssessment {
            permission: PermissionCapability::Shell,
            risk_level: 1,
            rule_id: "known.python.execute".to_string(),
            reason: "运行工作区 Python 程序".to_string(),
        });
    }

    // Default catch-all for unknown commands
    None
}
