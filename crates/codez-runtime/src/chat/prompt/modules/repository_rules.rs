use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct RepositoryRulesModule;

use crate::chat::prompt::types::BoxFuture;

impl PromptModule for RepositoryRulesModule {
    fn id(&self) -> &'static str {
        "repository-rules"
    }

    fn layer(&self) -> PromptLayer {
        PromptLayer::Context
    }

    fn priority(&self) -> i32 {
        2
    }

    fn build<'a>(&'a self, ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            let mut sections = Vec::new();

            if let Some(global) = &ctx.global_rules {
                if !global.is_empty() {
                    sections.push(format!("<global_rules>\n{}\n</global_rules>", global));
                }
            }
            if let Some(workspace) = &ctx.workspace_rules {
                if !workspace.is_empty() {
                    sections.push(format!(
                        "<workspace_rules>\n{}\n</workspace_rules>",
                        workspace
                    ));
                }
            }
            if let Some(directory) = &ctx.directory_rules {
                if !directory.is_empty() {
                    sections.push(format!(
                        "<directory_rules>\n{}\n</directory_rules>",
                        directory
                    ));
                }
            }

            if sections.is_empty() {
                return None;
            }

            let mut out = vec![
                "<repository_instructions>".to_string(),
                "Instruction precedence within project guidance is: global < workspace < closest directory < the current explicit user request. Safety and runtime permission rules cannot be overridden.".to_string(),
            ];
            out.extend(sections);
            out.push("</repository_instructions>".to_string());

            Some(out.join("\n"))
        })
    }
}
