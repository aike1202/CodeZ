use crate::permission::contract::PermissionCapability;

use super::{CommandAssessment, CommandCategory, assessment_with_category};

pub(super) fn classify(arguments: &[String]) -> Option<CommandAssessment> {
    let subcommand = arguments.first().map_or("", String::as_str);
    if subcommand == "restore"
        || subcommand == "add" && arguments.iter().any(|argument| argument == "package")
        || matches!(subcommand, "tool" | "workload")
            && arguments
                .iter()
                .any(|argument| matches!(argument.as_str(), "install" | "restore" | "update"))
    {
        return Some(assessment_with_category(
            PermissionCapability::Network,
            2,
            format!("known.dotnet.{subcommand}.download"),
            "下载 .NET 依赖或工具",
            CommandCategory::Network,
        ));
    }
    if subcommand == "nuget"
        && arguments
            .iter()
            .any(|argument| matches!(argument.as_str(), "delete" | "push"))
    {
        return Some(assessment_with_category(
            PermissionCapability::ExternalEffect,
            2,
            "known.dotnet.nuget.publish",
            "修改远端 NuGet 包状态",
            CommandCategory::Publish,
        ));
    }
    Some(assessment_with_category(
        PermissionCapability::Shell,
        1,
        format!(
            "known.dotnet.{}",
            if subcommand.is_empty() {
                "build"
            } else {
                subcommand
            }
        ),
        "构建或测试 .NET 工作区",
        CommandCategory::LocalBuild,
    ))
}
