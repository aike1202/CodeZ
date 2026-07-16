use std::collections::HashMap;
use serde_json::Value;
use tokio::fs;

use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct VerificationStrategyModule;

impl VerificationStrategyModule {
    async fn read_package_scripts(workspace_root: &std::path::Path) -> Option<HashMap<String, String>> {
        let package_json_path = workspace_root.join("package.json");
        if !package_json_path.exists() {
            return None;
        }

        let content = fs::read_to_string(&package_json_path).await.ok()?;
        let parsed: Value = serde_json::from_str(&content).ok()?;

        let scripts = parsed.get("scripts")?.as_object()?;
        let mut map = HashMap::new();
        for (k, v) in scripts {
            if let Some(s) = v.as_str() {
                map.insert(k.clone(), s.to_string());
            }
        }
        Some(map)
    }

    fn format_prompt_section(scripts: Option<HashMap<String, String>>) -> Option<String> {
        let scripts = scripts?;
        if scripts.is_empty() {
            return None;
        }

        let mut available = Vec::new();

        if scripts.contains_key("test") {
            available.push("- `npm test`: Run standard tests");
        }
        if scripts.contains_key("lint") {
            available.push("- `npm run lint`: Run code linter");
        }
        if scripts.contains_key("typecheck") {
            available.push("- `npm run typecheck`: Run type checking");
        }
        if scripts.contains_key("build") {
            available.push("- `npm run build`: Build the project");
        }

        if available.is_empty() {
            return None;
        }

        Some(format!(
            "<verification_strategy>\nAvailable NPM scripts for verification:\n{}\n\nAlways use standard package manager commands (e.g. `npm run ...` or `yarn ...`) rather than invoking underlying tools directly unless necessary.\n</verification_strategy>",
            available.join("\n")
        ))
    }
}

use crate::chat::prompt::types::BoxFuture;

impl PromptModule for VerificationStrategyModule {
    fn id(&self) -> &'static str {
        "verification-strategy"
    }

    fn layer(&self) -> PromptLayer {
        PromptLayer::Context
    }

    fn priority(&self) -> i32 {
        6
    }

    fn build<'a>(&'a self, ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            let scripts = Self::read_package_scripts(&ctx.workspace_root).await;
            Self::format_prompt_section(scripts)
        })
    }
}
