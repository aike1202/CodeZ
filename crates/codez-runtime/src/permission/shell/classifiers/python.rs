use crate::permission::contract::PermissionCapability;

use super::{CommandAssessment, CommandCategory, assessment_with_category};

pub(super) fn classify(executable: &str, arguments: &[String]) -> Option<CommandAssessment> {
    let subcommand = arguments.first().map_or("", String::as_str);
    if matches!(executable, "pip" | "pip3" | "uv")
        && matches!(
            subcommand,
            "add" | "download" | "install" | "sync" | "wheel"
        )
    {
        return Some(assessment_with_category(
            PermissionCapability::Network,
            2,
            format!("known.python.{executable}.{subcommand}"),
            "下载或安装 Python 依赖",
            CommandCategory::Network,
        ));
    }
    if matches!(executable, "python" | "python3" | "py") {
        if subcommand == "-m"
            && arguments
                .get(1)
                .is_some_and(|argument| matches!(argument.as_str(), "pip" | "uv"))
            && arguments
                .get(2)
                .is_some_and(|argument| matches!(argument.as_str(), "install" | "sync"))
        {
            return Some(assessment_with_category(
                PermissionCapability::Network,
                2,
                "known.python.module-install",
                "安装 Python 依赖",
                CommandCategory::Network,
            ));
        }
        return Some(assessment_with_category(
            PermissionCapability::Shell,
            1,
            "known.python.execute",
            "运行工作区 Python 程序",
            CommandCategory::LocalBuild,
        ));
    }
    Some(assessment_with_category(
        PermissionCapability::Shell,
        1,
        format!("known.python.{executable}.local"),
        "运行本地 Python 工具",
        CommandCategory::LocalBuild,
    ))
}
