use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct TodoManagementModule;

const TEXT: &str = r#"# Todo tracking

- Todo tools are optional durable collaboration state. Use them when substantial work benefits from visible progress tracking, resumability, approval, or meaningful dependencies. Do not create a Todo list for a simple request merely because it contains several actions or files.
- Todo items describe work, not Agent instances. Creating a Todo never implies spawning or assigning an Agent; delegate only when the work independently satisfies the delegation policy.
- Create related items in one TodoCreate batch when practical. The authoritative Todo state is injected into every model round; do not look for TodoGet or TodoList tools.
- Use one TodoUpdate call to commit related transitions atomically, such as completing the current item and starting the next. Put expectedRevision at the request root and item patches in updates[].
- Persist dependencies only through blockedBy using addBlockedBy/removeBlockedBy. Treat reverse blocks information as derived state.
- Mark a ready Todo item in_progress immediately before starting its work. Keep at most one item in_progress, and keep statuses current while continuing through executable work without repeatedly asking whether to proceed.
- Do not start or complete an item while the injected state reports unfinished dependencies or pending approval. Complete dependencies first and obtain required approval; the runtime enforces both gates.
- Mark an item completed only after its work is fully implemented, its acceptance criteria are satisfied, and relevant verification has run successfully. Keep partial, failed, or unverified work non-completed and report the blocker.
- A revision conflict includes the latest bounded Todo state. Rebase the intended batch on that state and retry once; do not blindly repeat stale arguments.
- Todo bookkeeping does not replace concise user-facing progress updates."#;

use crate::chat::prompt::types::BoxFuture;

impl PromptModule for TodoManagementModule {
    fn id(&self) -> &'static str {
        "todo-management"
    }

    fn layer(&self) -> PromptLayer {
        PromptLayer::Dynamic
    }

    fn priority(&self) -> i32 {
        6
    }

    fn is_enabled<'a>(&'a self, ctx: &'a PromptContext) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            ctx.available_tools.as_ref().is_none_or(|tools| {
                tools
                    .iter()
                    .any(|t| t.name == "TodoCreate" || t.name == "TodoUpdate")
            })
        })
    }

    fn build<'a>(&'a self, ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            Some(match &ctx.todo_state {
                Some(state) => format!("{TEXT}\n\n{state}"),
                None => TEXT.to_string(),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::TEXT;

    #[test]
    fn policy_should_keep_tasks_separate_from_agent_instances() {
        assert!(
            TEXT.contains("Todo items describe work, not Agent instances")
                && TEXT.contains("never implies spawning or assigning an Agent")
                && TEXT.contains("independently satisfies the delegation policy")
        );
    }

    #[test]
    fn policy_should_follow_revision_dependency_and_approval_gates() {
        assert!(
            TEXT.contains("expectedRevision")
                && TEXT.contains("addBlockedBy/removeBlockedBy")
                && TEXT.contains("unfinished dependencies or pending approval")
                && TEXT.contains("runtime enforces both gates")
        );
    }

    #[test]
    fn policy_should_start_and_complete_tasks_at_truthful_boundaries() {
        assert!(
            TEXT.contains("in_progress immediately before starting")
                && TEXT.contains("Keep at most one item in_progress")
                && TEXT.contains("relevant verification has run successfully")
                && TEXT.contains("partial, failed, or unverified work non-completed")
        );
    }
}
