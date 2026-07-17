use crate::permission::contract::PermissionCapability;

use super::{CommandAssessment, CommandCategory, assessment_with_category};

pub(super) fn classify(arguments: &[String]) -> Option<CommandAssessment> {
    let subcommand = arguments.first().map_or("", String::as_str);
    if matches!(subcommand, "get" | "install" | "mod") {
        return Some(assessment_with_category(
            PermissionCapability::Network,
            2,
            format!("known.go.{subcommand}"),
            "下载 Go 依赖",
            CommandCategory::Network,
        ));
    }
    Some(assessment_with_category(
        PermissionCapability::Shell,
        1,
        format!(
            "known.go.{}",
            if subcommand.is_empty() {
                "build"
            } else {
                subcommand
            }
        ),
        "构建或测试 Go 工作区",
        CommandCategory::LocalBuild,
    ))
}
