use crate::permission::contract::{PermissionCapability, PermissionRiskLevel};

pub struct CommandAssessment {
    pub permission: PermissionCapability,
    pub risk_level: PermissionRiskLevel,
    pub rule_id: String,
    pub reason: String,
}

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

const PACKAGE_NETWORK_COMMANDS: &[&str] = &[
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

fn assessment(
    permission: PermissionCapability,
    risk_level: PermissionRiskLevel,
    rule_id: impl Into<String>,
    reason: impl Into<String>,
) -> CommandAssessment {
    CommandAssessment {
        permission,
        risk_level,
        rule_id: rule_id.into(),
        reason: reason.into(),
    }
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

fn package_command_args(executable: &str, arguments: &[String]) -> Vec<String> {
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

fn is_force_push_argument(argument: &str) -> bool {
    let lower = argument.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "--force" | "-f" | "--force-with-lease" | "--force-if-includes" | "--mirror"
    ) || lower.starts_with("--force-with-lease=")
        || lower.starts_with("--force-if-includes=")
        || lower
            .strip_prefix('-')
            .is_some_and(|flags| !flags.starts_with('-') && flags.contains('f'))
        || lower.starts_with('+') && lower.len() > 1
}

fn git_branch_is_read_only(arguments: &[String]) -> bool {
    arguments.iter().skip(2).all(|argument| {
        matches!(
            argument.to_ascii_lowercase().as_str(),
            "-a" | "--all" | "-r" | "--remotes" | "-v" | "-vv" | "--verbose" | "--list"
        ) || argument.starts_with("--format=")
            || argument.starts_with("--contains=")
            || argument.starts_with("--no-contains=")
            || argument.starts_with("--merged=")
            || argument.starts_with("--no-merged=")
    })
}

fn is_gradle_publish_task(argument: &str) -> bool {
    let task = argument.rsplit(':').next().unwrap_or_default();
    task.starts_with("publish") && task != "publishtomavenlocal"
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
    let package_args = if matches!(executable.as_str(), "npm" | "pnpm" | "yarn" | "bun") {
        package_command_args(&executable, arguments)
    } else {
        Vec::new()
    };
    let subcommand = package_args
        .first()
        .or_else(|| args.first())
        .map_or("", String::as_str);

    if is_pure_version_query(&executable, arguments) {
        return Some(assessment(
            PermissionCapability::Shell,
            0,
            format!("known.version.{executable}"),
            "查看工具版本",
        ));
    }
    if READ_COMMANDS.contains(&executable.as_str()) {
        return Some(assessment(
            PermissionCapability::Shell,
            0,
            format!("known.read.{executable}"),
            "只读查询或输出转换命令",
        ));
    }
    if executable == "git" {
        let read_only = matches!(
            subcommand,
            "blame"
                | "describe"
                | "diff"
                | "grep"
                | "log"
                | "ls-files"
                | "rev-parse"
                | "shortlog"
                | "show"
                | "status"
        ) || subcommand == "branch" && git_branch_is_read_only(arguments);
        if read_only {
            return Some(assessment(
                PermissionCapability::Shell,
                0,
                format!("known.git.{subcommand}"),
                "只读 Git 操作",
            ));
        }
        if subcommand == "push"
            && args
                .iter()
                .skip(1)
                .any(|argument| is_force_push_argument(argument))
        {
            return Some(assessment(
                PermissionCapability::Hardline,
                4,
                "critical.git.force-push",
                "强制改写远端历史",
            ));
        }
        if subcommand == "reset" && args.iter().any(|argument| argument == "--hard")
            || subcommand == "clean"
                && args.iter().skip(1).any(|argument| {
                    argument == "--force"
                        || argument
                            .strip_prefix('-')
                            .is_some_and(|flags| !flags.starts_with('-') && flags.contains('f'))
                })
        {
            return Some(assessment(
                PermissionCapability::Delete,
                3,
                format!("known.git.{subcommand}.destructive"),
                "会丢弃本地 Git 状态",
            ));
        }
        if matches!(subcommand, "clone" | "fetch" | "pull" | "push") {
            return Some(assessment(
                PermissionCapability::Network,
                2,
                format!("known.git.{subcommand}.network"),
                "访问远端 Git 仓库",
            ));
        }
        return Some(assessment(
            PermissionCapability::Shell,
            1,
            format!(
                "known.git.{}",
                if subcommand.is_empty() {
                    "write"
                } else {
                    subcommand
                }
            ),
            "修改工作区 Git 状态",
        ));
    }
    if matches!(executable.as_str(), "npm" | "pnpm" | "yarn" | "bun") {
        let config_mutation = subcommand == "config"
            && package_args.get(1).is_some_and(|argument| {
                matches!(argument.as_str(), "delete" | "edit" | "set" | "unset")
            });
        if config_mutation || executable == "npm" && subcommand == "set" {
            return Some(assessment(
                PermissionCapability::ExternalEffect,
                2,
                format!("known.package.{executable}.config-write"),
                "修改包管理器配置",
            ));
        }
        if PACKAGE_NETWORK_COMMANDS.contains(&subcommand) {
            return Some(assessment(
                PermissionCapability::Network,
                2,
                format!("known.package.{executable}.{subcommand}"),
                "修改包或访问包服务",
            ));
        }
        if subcommand == "version" {
            return Some(assessment(
                PermissionCapability::ExternalEffect,
                1,
                format!("known.package.{executable}.version"),
                "修改包版本和本地 Git 状态",
            ));
        }
        return Some(assessment(
            PermissionCapability::Shell,
            1,
            format!("known.package.{executable}.script"),
            "运行工作区开发命令",
        ));
    }
    if matches!(executable.as_str(), "npx" | "pnpx") {
        return Some(assessment(
            PermissionCapability::Network,
            2,
            format!("known.package.{executable}.execute"),
            "下载或执行 Node.js 包",
        ));
    }
    if executable == "cargo" {
        if matches!(
            subcommand,
            "login" | "logout" | "owner" | "publish" | "yank"
        ) {
            return Some(assessment(
                PermissionCapability::ExternalEffect,
                2,
                format!("known.rust.cargo.{subcommand}"),
                "修改远端 Cargo 注册表状态",
            ));
        }
        if matches!(
            subcommand,
            "add" | "fetch" | "install" | "search" | "update"
        ) {
            return Some(assessment(
                PermissionCapability::Network,
                2,
                format!("known.rust.cargo.{subcommand}"),
                "下载依赖或访问 Cargo 注册表",
            ));
        }
        return Some(assessment(
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
        ));
    }
    if executable == "go" {
        if matches!(subcommand, "get" | "install" | "mod") {
            return Some(assessment(
                PermissionCapability::Network,
                2,
                format!("known.go.{subcommand}"),
                "下载 Go 依赖",
            ));
        }
        return Some(assessment(
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
        ));
    }
    if matches!(executable.as_str(), "mvn" | "mvnw") {
        if args
            .iter()
            .any(|argument| matches!(argument.rsplit(':').next(), Some("deploy" | "deploy-file")))
        {
            return Some(assessment(
                PermissionCapability::ExternalEffect,
                2,
                format!("known.java.{executable}.deploy"),
                "发布 Maven 构建产物",
            ));
        }
        if args.iter().any(|argument| {
            matches!(argument.as_str(), "-u" | "--update-snapshots")
                || argument.starts_with("dependency:")
                || argument.contains("maven-dependency-plugin")
        }) {
            return Some(assessment(
                PermissionCapability::Network,
                2,
                format!("known.java.{executable}.dependency"),
                "下载 Maven 依赖",
            ));
        }
        return Some(assessment(
            PermissionCapability::Shell,
            1,
            format!("known.java.{executable}"),
            "构建或测试 Java 工作区",
        ));
    }
    if matches!(executable.as_str(), "gradle" | "gradlew") {
        if args.iter().any(|argument| is_gradle_publish_task(argument)) {
            return Some(assessment(
                PermissionCapability::ExternalEffect,
                2,
                format!("known.java.{executable}.publish"),
                "发布 Gradle 构建产物",
            ));
        }
        if args
            .iter()
            .any(|argument| argument == "--refresh-dependencies")
        {
            return Some(assessment(
                PermissionCapability::Network,
                2,
                format!("known.java.{executable}.refresh-dependencies"),
                "刷新 Gradle 依赖",
            ));
        }
        return Some(assessment(
            PermissionCapability::Shell,
            1,
            format!("known.java.{executable}"),
            "构建或测试 Java 工作区",
        ));
    }
    if executable == "dotnet" {
        if subcommand == "restore"
            || subcommand == "add" && args.iter().any(|argument| argument == "package")
            || matches!(subcommand, "tool" | "workload")
                && args
                    .iter()
                    .any(|argument| matches!(argument.as_str(), "install" | "restore" | "update"))
        {
            return Some(assessment(
                PermissionCapability::Network,
                2,
                format!("known.dotnet.{subcommand}.download"),
                "下载 .NET 依赖或工具",
            ));
        }
        if subcommand == "nuget"
            && args
                .iter()
                .any(|argument| matches!(argument.as_str(), "delete" | "push"))
        {
            return Some(assessment(
                PermissionCapability::ExternalEffect,
                2,
                "known.dotnet.nuget.publish",
                "修改远端 NuGet 包状态",
            ));
        }
        return Some(assessment(
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
        ));
    }
    if matches!(executable.as_str(), "pip" | "pip3" | "uv")
        && matches!(
            subcommand,
            "add" | "download" | "install" | "sync" | "wheel"
        )
    {
        return Some(assessment(
            PermissionCapability::Network,
            2,
            format!("known.python.{executable}.{subcommand}"),
            "下载或安装 Python 依赖",
        ));
    }
    if matches!(executable.as_str(), "python" | "python3" | "py") {
        if subcommand == "-m"
            && args
                .get(1)
                .is_some_and(|argument| matches!(argument.as_str(), "pip" | "uv"))
            && args
                .get(2)
                .is_some_and(|argument| matches!(argument.as_str(), "install" | "sync"))
        {
            return Some(assessment(
                PermissionCapability::Network,
                2,
                "known.python.module-install",
                "安装 Python 依赖",
            ));
        }
        return Some(assessment(
            PermissionCapability::Shell,
            1,
            "known.python.execute",
            "运行工作区 Python 程序",
        ));
    }
    if matches!(executable.as_str(), "node" | "deno") {
        return Some(assessment(
            PermissionCapability::Shell,
            1,
            format!("known.javascript.{executable}"),
            "运行工作区 JavaScript 程序",
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
