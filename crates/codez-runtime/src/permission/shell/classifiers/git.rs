use crate::permission::contract::PermissionCapability;

use super::{CommandAssessment, CommandCategory, assessment_with_category};

fn is_force_push_argument(argument: &str) -> bool {
    matches!(
        argument,
        "--force" | "-f" | "--force-with-lease" | "--force-if-includes" | "--mirror"
    ) || argument.starts_with("--force-with-lease=")
        || argument.starts_with("--force-if-includes=")
        || argument
            .strip_prefix('-')
            .is_some_and(|flags| !flags.starts_with('-') && flags.contains('f'))
        || argument.starts_with('+') && argument.len() > 1
}

fn branch_is_read_only(arguments: &[String]) -> bool {
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

fn branch_deletes(arguments: &[String]) -> bool {
    arguments.iter().skip(2).any(|argument| {
        matches!(argument.to_ascii_lowercase().as_str(), "-d" | "--delete") || argument == "-D"
    })
}

pub(super) fn classify(
    arguments: &[String],
    lowercase_arguments: &[String],
) -> Option<CommandAssessment> {
    let subcommand = lowercase_arguments.first().map_or("", String::as_str);
    if subcommand == "branch" && branch_deletes(arguments) {
        return Some(assessment_with_category(
            PermissionCapability::Delete,
            3,
            "known.git.branch.delete",
            "删除本地 Git 分支",
            CommandCategory::LocalDelete,
        ));
    }
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
    ) || subcommand == "branch" && branch_is_read_only(arguments);
    if read_only {
        return Some(assessment_with_category(
            PermissionCapability::Shell,
            0,
            format!("known.git.{subcommand}"),
            "只读 Git 操作",
            CommandCategory::LocalRead,
        ));
    }
    if subcommand == "push"
        && lowercase_arguments
            .iter()
            .skip(1)
            .any(|argument| is_force_push_argument(argument))
    {
        return Some(assessment_with_category(
            PermissionCapability::Hardline,
            4,
            "critical.git.force-push",
            "强制改写远端历史",
            CommandCategory::Hardline,
        ));
    }
    if subcommand == "reset"
        && lowercase_arguments
            .iter()
            .any(|argument| argument == "--hard")
        || subcommand == "clean"
            && lowercase_arguments.iter().skip(1).any(|argument| {
                argument == "--force"
                    || argument
                        .strip_prefix('-')
                        .is_some_and(|flags| !flags.starts_with('-') && flags.contains('f'))
            })
    {
        return Some(assessment_with_category(
            PermissionCapability::Delete,
            3,
            format!("known.git.{subcommand}.destructive"),
            "会丢弃本地 Git 状态",
            CommandCategory::LocalDelete,
        ));
    }
    if matches!(subcommand, "clone" | "fetch" | "pull" | "push") {
        return Some(assessment_with_category(
            PermissionCapability::Network,
            2,
            format!("known.git.{subcommand}.network"),
            "访问远端 Git 仓库",
            CommandCategory::Network,
        ));
    }
    Some(assessment_with_category(
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
        CommandCategory::LocalMutation,
    ))
}

#[cfg(test)]
mod tests {
    use super::classify;
    use crate::permission::contract::PermissionCapability;

    fn classify_arguments(arguments: &[&str]) -> PermissionCapability {
        let arguments = arguments
            .iter()
            .map(|value| (*value).to_string())
            .collect::<Vec<_>>();
        let lowercase = arguments
            .iter()
            .skip(1)
            .map(|value| value.to_ascii_lowercase())
            .collect::<Vec<_>>();
        classify(&arguments, &lowercase)
            .expect("git command must classify")
            .permission
    }

    #[test]
    fn branch_listing_is_read_only_but_branch_deletion_is_not() {
        assert_eq!(
            classify_arguments(&["git", "branch", "--list"]),
            PermissionCapability::Shell
        );
        assert_eq!(
            classify_arguments(&["git", "branch", "-D", "obsolete"]),
            PermissionCapability::Delete
        );
    }
}
