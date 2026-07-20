use std::collections::BTreeSet;

use crate::chat::prompt::types::{BoxFuture, PromptContext, PromptLayer, PromptModule};

pub struct ToolUsageModule;

impl PromptModule for ToolUsageModule {
    fn id(&self) -> &'static str {
        "tool-usage"
    }

    fn layer(&self) -> PromptLayer {
        PromptLayer::Dynamic
    }

    fn priority(&self) -> i32 {
        1
    }

    fn build<'a>(&'a self, ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            render_tool_guidance(
                ctx.available_tools
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .map(|tool| tool.name.as_str()),
            )
        })
    }
}

fn render_tool_guidance<'a>(names: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let names = names.into_iter().collect::<BTreeSet<_>>();
    let has_read = names.contains("Read");
    let has_glob = names.contains("Glob");
    let has_grep = names.contains("Grep");
    let has_list = names.contains("list_files");
    let has_shell = names.contains("Bash") || names.contains("PowerShell");
    if !(has_read || has_glob || has_grep || has_list || has_shell) {
        return None;
    }

    let mut lines = vec![
        "<tool_usage>".to_string(),
        "Use specialized tools for workspace inspection; reserve shell tools for commands that require a shell. Start with the smallest directed query and narrow broad results before reading source.".to_string(),
    ];
    if has_read {
        lines.push(
            "- Read accepts exactly one known file through file_path. Never pass a files array, never guess conventional paths, and read only the range needed.".to_string(),
        );
    }
    if has_glob {
        lines.push(
            "- Use Glob to discover files by name or path pattern before Read when the exact path is unknown.".to_string(),
        );
    }
    if has_grep {
        lines.push(
            "- Use Grep for regex content search. Its path may be one existing file or directory; prefer files_with_matches first, then use content mode with a narrow path, glob, and head_limit.".to_string(),
        );
    }
    if has_list {
        lines.push(
            "- Use list_files to inspect direct directory children. Use Glob instead for recursive filename or extension discovery.".to_string(),
        );
    }
    if has_read && (has_glob || has_list) {
        lines.push(
            "- After a path-not-found error, inspect the returned path, discover the actual location, and change the input; do not repeat the same call.".to_string(),
        );
    }
    lines.push("</tool_usage>".to_string());
    Some(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::render_tool_guidance;

    #[test]
    fn guidance_routes_discovery_search_and_single_file_reads() {
        let rendered = render_tool_guidance(["Read", "Glob", "Grep", "list_files"])
            .expect("workspace tools must produce guidance");

        assert!(
            rendered.contains("exactly one known file")
                && rendered.contains("Never pass a files array")
                && rendered.contains("Use Glob to discover files")
                && rendered.contains("path may be one existing file or directory")
                && rendered.contains("do not repeat the same call")
        );
    }

    #[test]
    fn guidance_omits_unavailable_tool_rules() {
        let rendered = render_tool_guidance(["PowerShell"])
            .expect("a shell tool must produce focused guidance");

        assert!(!rendered.contains("Read accepts") && !rendered.contains("Use Glob"));
    }
}
