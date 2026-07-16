use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct EditingModule;

const TEXT: &str = r#"# Editing

- Read an existing file before editing it. When using Edit, copy only the content after Read's line-number prefix, preserve exact indentation, and group every known targeted change for the same file into one ordered edits array.
- Prefer targeted edits and preserve the project's formatting, naming, and architecture. Use Write only for new files or intentional full replacements.
- Reuse established patterns. Create files or abstractions only when the requested result actually needs them.
- Preserve user changes and unrelated work in a dirty workspace. Stop when the request is complete; cosmetic cleanup is not part of the task."#;

use crate::chat::prompt::types::BoxFuture;

impl PromptModule for EditingModule {
    fn id(&self) -> &'static str {
        "editing"
    }

    fn layer(&self) -> PromptLayer {
        PromptLayer::Execution
    }

    fn priority(&self) -> i32 {
        1
    }

    fn build<'a>(&'a self, _ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move { Some(TEXT.to_string()) })
    }
}
