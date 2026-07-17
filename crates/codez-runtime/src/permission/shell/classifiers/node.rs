use crate::permission::contract::PermissionCapability;

use super::{CommandAssessment, CommandCategory, assessment_with_category};

const NETWORK_SUBCOMMANDS: &[&str] = &[
    "access",
    "add",
    "audit",
    "ci",
    "create",
    "deprecate",
    "dist-tag",
    "dlx",
    "exec",
    "init",
    "install",
    "login",
    "logout",
    "owner",
    "publish",
    "remove",
    "token",
    "uninstall",
    "unpublish",
    "update",
    "x",
];

fn package_arguments(executable: &str, arguments: &[String]) -> Vec<String> {
    let directory_option = arguments
        .get(1)
        .map(|argument| argument.to_ascii_lowercase())
        .unwrap_or_default();
    let has_directory_option = executable == "npm" && directory_option == "--prefix"
        || executable == "pnpm" && matches!(directory_option.as_str(), "-c" | "--dir")
        || matches!(executable, "yarn" | "bun") && directory_option == "--cwd";
    arguments
        .iter()
        .skip(if has_directory_option && arguments.get(2).is_some() {
            3
        } else {
            1
        })
        .map(|argument| argument.to_ascii_lowercase())
        .collect()
}

pub(super) fn classify(executable: &str, arguments: &[String]) -> Option<CommandAssessment> {
    if matches!(executable, "node" | "deno") {
        return Some(assessment_with_category(
            PermissionCapability::Shell,
            1,
            format!("known.javascript.{executable}"),
            "运行工作区 JavaScript 程序",
            CommandCategory::LocalBuild,
        ));
    }
    if matches!(executable, "npx" | "pnpx") {
        return Some(assessment_with_category(
            PermissionCapability::Network,
            2,
            format!("known.package.{executable}.execute"),
            "下载或执行 Node.js 包",
            CommandCategory::Network,
        ));
    }
    let package_arguments = package_arguments(executable, arguments);
    let subcommand = package_arguments.first().map_or("", String::as_str);
    let config_mutation = subcommand == "config"
        && package_arguments.get(1).is_some_and(|argument| {
            matches!(argument.as_str(), "delete" | "edit" | "set" | "unset")
        });
    if config_mutation || executable == "npm" && subcommand == "set" {
        return Some(assessment_with_category(
            PermissionCapability::ExternalEffect,
            2,
            format!("known.package.{executable}.config-write"),
            "修改包管理器配置",
            CommandCategory::ExternalEffect,
        ));
    }
    if NETWORK_SUBCOMMANDS.contains(&subcommand) {
        return Some(assessment_with_category(
            PermissionCapability::Network,
            2,
            format!("known.package.{executable}.{subcommand}"),
            "修改包或访问包服务",
            CommandCategory::Network,
        ));
    }
    if subcommand == "version" {
        return Some(assessment_with_category(
            PermissionCapability::ExternalEffect,
            1,
            format!("known.package.{executable}.version"),
            "修改包版本和本地 Git 状态",
            CommandCategory::LocalMutation,
        ));
    }
    Some(assessment_with_category(
        PermissionCapability::Shell,
        1,
        format!("known.package.{executable}.script"),
        "运行工作区开发命令",
        CommandCategory::LocalBuild,
    ))
}
