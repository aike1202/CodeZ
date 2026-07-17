mod dotnet;
mod git;
mod go;
mod java;
mod node;
mod python;
mod rust;

use crate::permission::contract::{PermissionCapability, PermissionRiskLevel};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandCategory {
    LocalRead,
    LocalBuild,
    LocalMutation,
    LocalDelete,
    Network,
    Publish,
    Deploy,
    RemoteMutation,
    ExternalEffect,
    Dynamic,
    Hardline,
}

pub struct CommandAssessment {
    pub permission: PermissionCapability,
    pub risk_level: PermissionRiskLevel,
    pub rule_id: String,
    pub reason: String,
    pub category: CommandCategory,
}

pub(super) fn assessment(
    permission: PermissionCapability,
    risk_level: PermissionRiskLevel,
    rule_id: impl Into<String>,
    reason: impl Into<String>,
) -> CommandAssessment {
    let category = match permission {
        PermissionCapability::Read => CommandCategory::LocalRead,
        PermissionCapability::Edit | PermissionCapability::Rollback => {
            CommandCategory::LocalMutation
        }
        PermissionCapability::Shell if risk_level == 0 => CommandCategory::LocalRead,
        PermissionCapability::Shell => CommandCategory::LocalBuild,
        PermissionCapability::Delete => CommandCategory::LocalDelete,
        PermissionCapability::Network => CommandCategory::Network,
        PermissionCapability::Hardline => CommandCategory::Hardline,
        PermissionCapability::ShellUnparsed | PermissionCapability::Unknown => {
            CommandCategory::Dynamic
        }
        PermissionCapability::ExternalEffect | PermissionCapability::ExternalDirectory => {
            CommandCategory::ExternalEffect
        }
    };
    assessment_with_category(permission, risk_level, rule_id, reason, category)
}

pub(super) fn assessment_with_category(
    permission: PermissionCapability,
    risk_level: PermissionRiskLevel,
    rule_id: impl Into<String>,
    reason: impl Into<String>,
    category: CommandCategory,
) -> CommandAssessment {
    CommandAssessment {
        permission,
        risk_level,
        rule_id: rule_id.into(),
        reason: reason.into(),
        category,
    }
}

pub(super) fn classify_domain_command(
    executable: &str,
    arguments: &[String],
    lowercase_arguments: &[String],
) -> Option<CommandAssessment> {
    match executable {
        "git" => git::classify(arguments, lowercase_arguments),
        "npm" | "pnpm" | "yarn" | "bun" | "npx" | "pnpx" | "node" | "deno" => {
            node::classify(executable, arguments)
        }
        "cargo" => rust::classify(lowercase_arguments),
        "go" => go::classify(lowercase_arguments),
        "mvn" | "mvnw" | "gradle" | "gradlew" => java::classify(executable, lowercase_arguments),
        "dotnet" => dotnet::classify(lowercase_arguments),
        "pip" | "pip3" | "uv" | "python" | "python3" | "py" => {
            python::classify(executable, lowercase_arguments)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::classify_domain_command;
    use crate::permission::contract::PermissionCapability;

    fn permission(arguments: &[&str]) -> PermissionCapability {
        let arguments = arguments
            .iter()
            .map(|argument| (*argument).to_string())
            .collect::<Vec<_>>();
        let executable = arguments[0].to_ascii_lowercase();
        let lowercase = arguments
            .iter()
            .skip(1)
            .map(|argument| argument.to_ascii_lowercase())
            .collect::<Vec<_>>();
        classify_domain_command(&executable, &arguments, &lowercase)
            .expect("domain command must classify")
            .permission
    }

    #[test]
    fn project_builds_and_dependency_or_publish_actions_have_distinct_capabilities() {
        let cases = [
            (("cargo", "clippy"), PermissionCapability::Shell),
            (("cargo", "publish"), PermissionCapability::ExternalEffect),
            (("npm", "run"), PermissionCapability::Shell),
            (("npm", "install"), PermissionCapability::Network),
            (("go", "test"), PermissionCapability::Shell),
            (("go", "get"), PermissionCapability::Network),
            (("mvn", "test"), PermissionCapability::Shell),
            (("mvn", "deploy"), PermissionCapability::ExternalEffect),
            (("dotnet", "test"), PermissionCapability::Shell),
            (("dotnet", "restore"), PermissionCapability::Network),
            (("python", "app.py"), PermissionCapability::Shell),
        ];
        for ((executable, subcommand), expected) in cases {
            assert_eq!(permission(&[executable, subcommand]), expected);
        }
        assert_eq!(
            permission(&["python", "-m", "pip", "install", "demo"]),
            PermissionCapability::Network
        );
    }
}
