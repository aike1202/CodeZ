use std::sync::Arc;
use futures::future::join_all;

use super::types::{PromptContext, PromptLayer, PromptModule};

pub const SYSTEM_PROMPT_DYNAMIC_BOUNDARY: &str = "<codez_dynamic_capabilities>";

pub struct PromptPipeline {
    modules: Vec<Arc<dyn PromptModule>>,
}

impl PromptPipeline {
    pub fn new() -> Self {
        Self { modules: Vec::new() }
    }

    pub fn register<M: PromptModule + 'static>(mut self, module: M) -> Self {
        let id = module.id();
        if let Some(idx) = self.modules.iter().position(|m| m.id() == id) {
            self.modules[idx] = Arc::new(module);
        } else {
            self.modules.push(Arc::new(module));
        }
        self
    }

    pub fn register_arc(mut self, module: Arc<dyn PromptModule>) -> Self {
        let id = module.id();
        if let Some(idx) = self.modules.iter().position(|m| m.id() == id) {
            self.modules[idx] = module;
        } else {
            self.modules.push(module);
        }
        self
    }

    fn sorted_modules(&self) -> Vec<Arc<dyn PromptModule>> {
        let mut sorted = self.modules.clone();
        sorted.sort_by(|a, b| {
            let layer_diff = (a.layer() as i32).cmp(&(b.layer() as i32));
            if layer_diff != std::cmp::Ordering::Equal {
                layer_diff
            } else {
                a.priority().cmp(&b.priority())
            }
        });
        sorted
    }

    pub async fn run(&self, ctx: &PromptContext) -> String {
        let sorted = self.sorted_modules();
        let futures = sorted.into_iter().map(|module| async move {
            let m = module.clone();
            if m.is_enabled(ctx).await {
                if let Some(text) = m.build(ctx).await {
                    let trimmed = text.trim().to_string();
                    if !trimmed.is_empty() {
                        return Some((m, trimmed));
                    }
                }
            }
            None
        });

        let results = join_all(futures).await;
        let active: Vec<_> = results.into_iter().flatten().collect();

        let static_sections: Vec<String> = active
            .iter()
            .filter(|(m, _)| m.layer() == PromptLayer::Core || m.layer() == PromptLayer::Execution)
            .map(|(_, text)| text.clone())
            .collect();

        let dynamic_sections: Vec<String> = active
            .iter()
            .filter(|(m, _)| m.layer() != PromptLayer::Core && m.layer() != PromptLayer::Execution)
            .map(|(_, text)| text.clone())
            .collect();

        if static_sections.is_empty() {
            return dynamic_sections.join("\n\n");
        }
        if dynamic_sections.is_empty() {
            return static_sections.join("\n\n");
        }

        format!(
            "{}\n\n{}\n\n{}",
            static_sections.join("\n\n"),
            SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
            dynamic_sections.join("\n\n")
        )
    }

    pub async fn list_enabled(&self, ctx: &PromptContext) -> Vec<(&'static str, PromptLayer, i32)> {
        let sorted = self.sorted_modules();
        let mut enabled = Vec::new();
        for module in sorted {
            if module.is_enabled(ctx).await {
                enabled.push((module.id(), module.layer(), module.priority()));
            }
        }
        enabled
    }
}
