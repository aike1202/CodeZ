use crate::permission::contract::PermissionCapability;

use super::{CommandAssessment, CommandCategory, assessment_with_category};

pub(super) fn classify(lowercase_arguments: &[String]) -> Option<CommandAssessment> {
    let subcommand = lowercase_arguments.first().map_or("", String::as_str);
    if matches!(
        subcommand,
        "login" | "logout" | "owner" | "publish" | "yank"
    ) {
        return Some(assessment_with_category(
            PermissionCapability::ExternalEffect,
            2,
            format!("known.rust.cargo.{subcommand}"),
            "修改远端 Cargo 注册表状态",
            CommandCategory::ExternalEffect,
        ));
    }
    if matches!(
        subcommand,
        "add" | "fetch" | "install" | "search" | "update"
    ) {
        return Some(assessment_with_category(
            PermissionCapability::Network,
            2,
            format!("known.rust.cargo.{subcommand}"),
            "下载依赖或访问 Cargo 注册表",
            CommandCategory::Network,
        ));
    }
    Some(assessment_with_category(
        PermissionCapability::Shell,
        1,
        format!(
            "known.rust.cargo.{}",
            if subcommand.is_empty() {
                "build"
            } else {
                subcommand
            }
        ),
        "构建、检查或测试 Rust 工作区",
        CommandCategory::LocalBuild,
    ))
}
