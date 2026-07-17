pub use super::classifiers::CommandAssessment;
use super::classifiers::{assessment, classify_domain_command};
use crate::permission::contract::PermissionCapability;

const READ_COMMANDS: &[&str] = &[
    "%",
    "?",
    "cat",
    "compare-object",
    "convertfrom-json",
    "convertfrom-stringdata",
    "convertto-csv",
    "convertto-html",
    "convertto-json",
    "convertto-xml",
    "diff",
    "dir",
    "echo",
    "fl",
    "foreach",
    "foreach-object",
    "format-custom",
    "format-list",
    "format-table",
    "format-wide",
    "ft",
    "fw",
    "gc",
    "gci",
    "get-childitem",
    "get-content",
    "get-item",
    "get-itemproperty",
    "get-location",
    "gi",
    "gl",
    "grep",
    "group",
    "group-object",
    "head",
    "ls",
    "measure",
    "measure-object",
    "out-string",
    "pwd",
    "resolve-path",
    "rg",
    "select",
    "select-object",
    "select-string",
    "sort",
    "sort-object",
    "sls",
    "tail",
    "test-path",
    "type",
    "where",
    "where-object",
    "which",
    "write-host",
    "write-output",
];

const BUILD_COMMANDS: &[&str] = &[
    "ant",
    "bazel",
    "bazelisk",
    "buck",
    "buck2",
    "cmake",
    "make",
    "meson",
    "msbuild",
    "ninja",
    "pytest",
    "sbt",
    "swift",
    "vitest",
    "xbuild",
    "xcodebuild",
];

const POWERSHELL_WRITE_COMMANDS: &[&str] = &[
    "ac",
    "add-content",
    "clear-content",
    "copy-item",
    "cp",
    "csvde",
    "export-clixml",
    "export-csv",
    "move-item",
    "mv",
    "new-item",
    "ni",
    "out-file",
    "rename-item",
    "ren",
    "sc",
    "set-content",
    "set-item",
    "set-itemproperty",
    "sp",
    "tee-object",
];

const DELETE_COMMANDS: &[&str] = &["del", "erase", "rd", "remove-item", "ri", "rm", "rmdir"];

#[must_use]
pub fn normalize_executable_name(executable: &str) -> String {
    let name = executable
        .trim_matches(['\'', '"'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    [".exe", ".cmd", ".bat", ".ps1", ".sh"]
        .iter()
        .find_map(|suffix| name.strip_suffix(suffix))
        .unwrap_or(&name)
        .to_string()
}

fn is_pure_version_query(executable: &str, arguments: &[String]) -> bool {
    let args = arguments
        .iter()
        .skip(1)
        .map(|argument| argument.to_ascii_lowercase())
        .collect::<Vec<_>>();
    args.len() == 1
        && (matches!(args[0].as_str(), "--version" | "-version" | "-v")
            || args[0] == "version" && executable == "go")
}

#[must_use]
pub fn classify_known_command(arguments: &[String]) -> Option<CommandAssessment> {
    let executable = normalize_executable_name(arguments.first().map_or("", String::as_str));
    if executable.is_empty() {
        return None;
    }
    let args = arguments
        .iter()
        .skip(1)
        .map(|argument| argument.to_ascii_lowercase())
        .collect::<Vec<_>>();
    if is_pure_version_query(&executable, arguments) {
        return Some(assessment(
            PermissionCapability::Shell,
            0,
            format!("known.version.{executable}"),
            "查看工具版本",
        ));
    }
    if let Some(assessment) = classify_domain_command(&executable, arguments, &args) {
        return Some(assessment);
    }
    if READ_COMMANDS.contains(&executable.as_str()) {
        return Some(assessment(
            PermissionCapability::Shell,
            0,
            format!("known.read.{executable}"),
            "只读查询或输出转换命令",
        ));
    }
    if BUILD_COMMANDS.contains(&executable.as_str()) {
        return Some(assessment(
            PermissionCapability::Shell,
            1,
            format!("known.build.{executable}"),
            "构建或测试工作区",
        ));
    }
    if matches!(
        executable.as_str(),
        "curl" | "invoke-restmethod" | "invoke-webrequest" | "irm" | "iwr" | "wget"
    ) {
        return Some(assessment(
            PermissionCapability::Network,
            2,
            format!("known.network.{executable}"),
            "访问外部网络",
        ));
    }
    if POWERSHELL_WRITE_COMMANDS.contains(&executable.as_str()) {
        return Some(assessment(
            PermissionCapability::Edit,
            1,
            format!("known.powershell.{executable}.write"),
            "写入或移动文件",
        ));
    }
    if DELETE_COMMANDS.contains(&executable.as_str()) {
        return Some(assessment(
            PermissionCapability::Delete,
            3,
            format!("known.delete.{executable}"),
            "删除文件或目录",
        ));
    }
    if matches!(executable.as_str(), "invoke-expression" | "iex") {
        return Some(assessment(
            PermissionCapability::ShellUnparsed,
            3,
            "known.powershell.dynamic-execution",
            "动态执行 PowerShell 表达式",
        ));
    }
    if matches!(
        executable.as_str(),
        "bash" | "cmd" | "powershell" | "pwsh" | "sh" | "zsh"
    ) {
        return Some(assessment(
            PermissionCapability::ShellUnparsed,
            2,
            format!("known.shell.{executable}.nested"),
            "嵌套 Shell 命令需要继续分析",
        ));
    }
    if matches!(
        executable.as_str(),
        "docker" | "helm" | "kubectl" | "start-process" | "stop-process" | "terraform" | "tofu"
    ) {
        return Some(assessment(
            PermissionCapability::ExternalEffect,
            2,
            format!("known.platform.{executable}"),
            "影响外部进程或运行环境",
        ));
    }
    if matches!(
        executable.as_str(),
        "aws"
            | "az"
            | "gcloud"
            | "gh"
            | "glab"
            | "mysql"
            | "mysqlsh"
            | "psql"
            | "redis-cli"
            | "sqlcmd"
    ) {
        return Some(assessment(
            PermissionCapability::ExternalEffect,
            2,
            format!("known.remote.{executable}"),
            "访问或修改远端服务状态",
        ));
    }
    if matches!(executable.as_str(), "cd" | "set-location" | "sl") {
        return Some(assessment(
            PermissionCapability::Shell,
            0,
            "known.shell.location",
            "切换工作区内的当前目录",
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::classify_known_command;
    use crate::permission::contract::PermissionCapability;

    fn arguments(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn cargo_clippy_is_a_known_local_shell_command() {
        let classified = classify_known_command(&arguments(&[
            "cargo",
            "clippy",
            "--all-targets",
            "--",
            "-D",
            "warnings",
        ]));

        assert!(
            classified
                .is_some_and(|assessment| assessment.permission == PermissionCapability::Shell)
        );
    }

    #[test]
    fn powershell_projection_cmdlets_are_read_only() {
        for executable in [
            "Get-ChildItem",
            "Select-Object",
            "Format-Table",
            "ForEach-Object",
        ] {
            let classified = classify_known_command(&arguments(&[executable]));
            assert!(
                classified
                    .is_some_and(|assessment| assessment.permission == PermissionCapability::Shell),
                "{executable} should be classified as a read-only shell command"
            );
        }
    }

    #[test]
    fn cargo_registry_mutations_are_not_local_shell_commands() {
        let classified = classify_known_command(&arguments(&["cargo", "publish"]));

        assert!(classified.is_some_and(|assessment| {
            assessment.permission == PermissionCapability::ExternalEffect
        }));
    }
}
