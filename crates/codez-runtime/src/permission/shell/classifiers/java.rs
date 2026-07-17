use crate::permission::contract::PermissionCapability;

use super::{CommandAssessment, CommandCategory, assessment_with_category};

fn is_gradle_publish_task(argument: &str) -> bool {
    let task = argument.rsplit(':').next().unwrap_or_default();
    task.starts_with("publish") && task != "publishtomavenlocal"
}

pub(super) fn classify(executable: &str, arguments: &[String]) -> Option<CommandAssessment> {
    if matches!(executable, "mvn" | "mvnw") {
        if arguments
            .iter()
            .any(|argument| matches!(argument.rsplit(':').next(), Some("deploy" | "deploy-file")))
        {
            return Some(assessment_with_category(
                PermissionCapability::ExternalEffect,
                2,
                format!("known.java.{executable}.deploy"),
                "发布 Maven 构建产物",
                CommandCategory::Publish,
            ));
        }
        if arguments.iter().any(|argument| {
            matches!(argument.as_str(), "-u" | "--update-snapshots")
                || argument.starts_with("dependency:")
                || argument.contains("maven-dependency-plugin")
        }) {
            return Some(assessment_with_category(
                PermissionCapability::Network,
                2,
                format!("known.java.{executable}.dependency"),
                "下载 Maven 依赖",
                CommandCategory::Network,
            ));
        }
    } else {
        if arguments
            .iter()
            .any(|argument| is_gradle_publish_task(argument))
        {
            return Some(assessment_with_category(
                PermissionCapability::ExternalEffect,
                2,
                format!("known.java.{executable}.publish"),
                "发布 Gradle 构建产物",
                CommandCategory::Publish,
            ));
        }
        if arguments
            .iter()
            .any(|argument| argument == "--refresh-dependencies")
        {
            return Some(assessment_with_category(
                PermissionCapability::Network,
                2,
                format!("known.java.{executable}.refresh-dependencies"),
                "刷新 Gradle 依赖",
                CommandCategory::Network,
            ));
        }
    }
    Some(assessment_with_category(
        PermissionCapability::Shell,
        1,
        format!("known.java.{executable}"),
        "构建或测试 Java 工作区",
        CommandCategory::LocalBuild,
    ))
}
