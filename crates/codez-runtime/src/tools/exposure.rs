use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::tools::registry::{ToolDescriptor, ToolHandler};
use crate::tools::types::{AgentRole, DeferredToolSummary, ToolExposure};

#[derive(Clone)]
pub struct ToolCatalogSnapshot {
    pub id: String,
    pub created_at: String,
    pub descriptors: Vec<Arc<dyn ToolDescriptor>>,
    pub aliases: HashMap<String, String>,
    pub fingerprint: String,
    handlers_by_canonical_name: HashMap<String, Arc<dyn ToolHandler>>,
}

impl std::fmt::Debug for ToolCatalogSnapshot {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ToolCatalogSnapshot")
            .field("id", &self.id)
            .field("created_at", &self.created_at)
            .field("descriptors", &self.descriptors)
            .field("aliases", &self.aliases)
            .field("fingerprint", &self.fingerprint)
            .finish_non_exhaustive()
    }
}

/// Invalid catalog definitions rejected before any model can reference them.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ToolCatalogError {
    #[error("tool catalog contains duplicate name or alias '{0}'")]
    DuplicateName(String),
}

impl ToolCatalogSnapshot {
    /// Creates an immutable handler catalog and validates canonical names and aliases.
    pub fn from_handlers(
        id: impl Into<String>,
        handlers: Vec<Arc<dyn ToolHandler>>,
    ) -> Result<Self, ToolCatalogError> {
        let mut descriptors = Vec::with_capacity(handlers.len());
        let mut aliases = HashMap::new();
        let mut handlers_by_canonical_name = HashMap::new();

        for handler in handlers {
            let descriptor = handler.descriptor();
            let canonical = descriptor.name().to_string();
            if aliases.contains_key(&canonical)
                || handlers_by_canonical_name.contains_key(&canonical)
            {
                return Err(ToolCatalogError::DuplicateName(canonical));
            }
            for alias in descriptor.aliases() {
                if alias == canonical
                    || aliases.contains_key(alias)
                    || handlers_by_canonical_name.contains_key(alias)
                {
                    return Err(ToolCatalogError::DuplicateName(alias.to_string()));
                }
                aliases.insert(alias.to_string(), canonical.clone());
            }
            handlers_by_canonical_name.insert(canonical, Arc::clone(&handler));
            descriptors.push(handler_descriptor(handler));
        }

        let fingerprint = fingerprint_schemas(&descriptors);
        Ok(Self {
            id: id.into(),
            created_at: chrono::Utc::now().to_rfc3339(),
            descriptors,
            aliases,
            fingerprint,
            handlers_by_canonical_name,
        })
    }

    /// Resolves one canonical tool handler from this immutable snapshot.
    #[must_use]
    pub fn handler(&self, canonical_name: &str) -> Option<&Arc<dyn ToolHandler>> {
        self.handlers_by_canonical_name.get(canonical_name)
    }

    /// Resolves an alias without consulting mutable global state.
    #[must_use]
    pub fn canonical_name<'a>(&'a self, requested_name: &'a str) -> &'a str {
        self.aliases
            .get(requested_name)
            .map_or(requested_name, String::as_str)
    }
}

fn handler_descriptor(handler: Arc<dyn ToolHandler>) -> Arc<dyn ToolDescriptor> {
    struct HandlerDescriptor(Arc<dyn ToolHandler>);

    impl std::fmt::Debug for HandlerDescriptor {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            self.0.descriptor().fmt(formatter)
        }
    }

    impl ToolDescriptor for HandlerDescriptor {
        fn name(&self) -> &'static str {
            self.0.descriptor().name()
        }
        fn aliases(&self) -> Vec<&'static str> {
            self.0.descriptor().aliases()
        }
        fn version(&self) -> &'static str {
            self.0.descriptor().version()
        }
        fn source(&self) -> crate::tools::types::ToolSource {
            self.0.descriptor().source()
        }
        fn source_id(&self) -> String {
            self.0.descriptor().source_id()
        }
        fn summary(&self) -> String {
            self.0.descriptor().summary()
        }
        fn description(&self) -> String {
            self.0.descriptor().description()
        }
        fn search_hint(&self) -> Option<String> {
            self.0.descriptor().search_hint()
        }
        fn input_schema(&self) -> Value {
            self.0.descriptor().input_schema()
        }
        fn output_schema(&self) -> Option<Value> {
            self.0.descriptor().output_schema()
        }
        fn approval(&self) -> crate::tools::types::ToolApprovalMetadata {
            self.0.descriptor().approval()
        }
        fn availability(&self) -> crate::tools::registry::ToolAvailability {
            self.0.descriptor().availability()
        }
        fn behavior(&self) -> crate::tools::registry::ToolBehavior {
            self.0.descriptor().behavior()
        }
        fn is_enabled(&self, context: &crate::tools::types::ToolAvailabilityContext) -> bool {
            self.0.descriptor().is_enabled(context)
        }
        fn is_read_only(&self, input: &Value) -> bool {
            self.0.descriptor().is_read_only(input)
        }
        fn is_destructive(&self, input: &Value) -> bool {
            self.0.descriptor().is_destructive(input)
        }
        fn plan_effects<'a>(
            &'a self,
            input: &'a Value,
            context: &'a crate::tools::types::ToolPlanningContext,
        ) -> crate::tools::registry::BoxFuture<'a, crate::tools::types::ToolEffectPlan> {
            self.0.descriptor().plan_effects(input, context)
        }
        fn resource_keys<'a>(
            &'a self,
            input: &'a Value,
            context: &'a crate::tools::types::ToolPlanningContext,
        ) -> crate::tools::registry::BoxFuture<'a, Vec<String>> {
            self.0.descriptor().resource_keys(input, context)
        }
    }

    Arc::new(HandlerDescriptor(handler))
}

#[derive(Debug, Clone)]
pub struct ToolExposurePlan {
    pub id: String,
    pub catalog_snapshot_id: String,
    pub eager_tools: Vec<Arc<dyn ToolDescriptor>>,
    pub deferred_tools: Vec<DeferredToolSummary>,
    pub hidden_tools: Vec<HiddenTool>,
    pub schema_fingerprint: String,
    pub estimated_schema_tokens: usize,
}

#[derive(Debug, Clone)]
pub struct HiddenTool {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct ToolExposureRequest {
    pub catalog: ToolCatalogSnapshot,
    pub agent_role: AgentRole,
    pub denied_tools: Option<HashSet<String>>,
    pub activated_deferred_tools: Option<HashSet<String>>,
    pub max_tools: Option<usize>,
    pub schema_token_budget: Option<usize>,
}

fn estimate_tokens(descriptor: &dyn ToolDescriptor) -> usize {
    let input_schema_json = serde_json::to_string(&descriptor.input_schema()).unwrap_or_default();
    let chars = descriptor.name().len() + descriptor.description().len() + input_schema_json.len();
    chars.div_ceil(4)
}

fn fingerprint_schemas(descriptors: &[Arc<dyn ToolDescriptor>]) -> String {
    #[derive(Serialize)]
    struct FingerprintItem<'a> {
        name: &'a str,
        version: &'a str,
        description: String,
        input_schema: Value,
    }

    let items: Vec<FingerprintItem> = descriptors
        .iter()
        .map(|d| FingerprintItem {
            name: d.name(),
            version: d.version(),
            description: d.description(),
            input_schema: d.input_schema(),
        })
        .collect();

    let json = serde_json::to_string(&items).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(json.as_bytes());
    hex::encode(hasher.finalize())
}

pub struct ToolExposurePlanner;

impl ToolExposurePlanner {
    pub fn plan(request: ToolExposureRequest) -> ToolExposurePlan {
        let activated = request.activated_deferred_tools.unwrap_or_default();
        let denied = request.denied_tools.unwrap_or_default();

        let mut eager = Vec::new();
        let mut deferred = Vec::new();
        let mut hidden = Vec::new();

        for descriptor in request.catalog.descriptors.into_iter() {
            let roles = &descriptor.availability().roles;
            if let Some(r) = roles {
                if !r.contains(&request.agent_role) {
                    hidden.push(HiddenTool {
                        name: descriptor.name().to_string(),
                        reason: "agent-role".to_string(),
                    });
                    continue;
                }
            }
            if denied.contains(descriptor.name()) {
                hidden.push(HiddenTool {
                    name: descriptor.name().to_string(),
                    reason: "permission-deny".to_string(),
                });
                continue;
            }
            if descriptor.availability().exposure == ToolExposure::Internal {
                hidden.push(HiddenTool {
                    name: descriptor.name().to_string(),
                    reason: "internal".to_string(),
                });
                continue;
            }
            if descriptor.availability().exposure == ToolExposure::Deferred
                && !activated.contains(descriptor.name())
            {
                deferred.push(descriptor);
                continue;
            }
            eager.push(descriptor);
        }

        let max_tools = request.max_tools.unwrap_or(usize::MAX);
        let token_budget = request.schema_token_budget.unwrap_or(usize::MAX);

        // Sort eager
        eager.sort_by(|a, b| {
            let rank_a = if a.availability().exposure == ToolExposure::Always {
                0
            } else {
                1
            };
            let rank_b = if b.availability().exposure == ToolExposure::Always {
                0
            } else {
                1
            };
            rank_a.cmp(&rank_b).then_with(|| a.name().cmp(b.name()))
        });

        let mut selected = Vec::new();
        let mut estimated_schema_tokens = 0;

        for descriptor in eager {
            let tokens = estimate_tokens(&*descriptor);
            let must_load = descriptor.availability().exposure == ToolExposure::Always;

            if !must_load
                && (selected.len() >= max_tools || estimated_schema_tokens + tokens > token_budget)
            {
                deferred.push(descriptor);
                continue;
            }

            selected.push(descriptor);
            estimated_schema_tokens += tokens;
        }

        let schema_fingerprint = fingerprint_schemas(&selected);
        let id = format!(
            "exposure_{}_{}",
            &schema_fingerprint[0..16],
            &Uuid::new_v4().to_string()[0..8]
        );

        deferred.sort_by(|a, b| a.name().cmp(b.name()));
        let deferred_tools = deferred
            .into_iter()
            .map(|d| DeferredToolSummary {
                name: d.name().to_string(),
                summary: d.summary(),
                search_hint: d.search_hint(),
            })
            .collect();

        ToolExposurePlan {
            id,
            catalog_snapshot_id: request.catalog.id,
            eager_tools: selected,
            deferred_tools,
            hidden_tools: hidden,
            schema_fingerprint,
            estimated_schema_tokens,
        }
    }
}

#[derive(Default)]
pub struct ToolExposureState {
    activated_by_scope: RwLock<HashMap<String, HashSet<String>>>,
}

impl ToolExposureState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, scope_id: &str) -> HashSet<String> {
        let map = self
            .activated_by_scope
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        map.get(scope_id).cloned().unwrap_or_default()
    }

    pub fn activate(&self, scope_id: &str, tool_names: &[String]) {
        let mut map = self
            .activated_by_scope
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let set = map.entry(scope_id.to_string()).or_default();
        for name in tool_names {
            set.insert(name.clone());
        }
    }

    pub fn restore_session(
        &self,
        session_id: &str,
        activated_by_context_scope: Option<&HashMap<String, Vec<String>>>,
    ) {
        if let Some(map) = activated_by_context_scope {
            for (context_scope_id, tool_names) in map {
                self.activate(&format!("{}:{}", session_id, context_scope_id), tool_names);
            }
        }
    }

    pub fn clear(&self, scope_id: Option<&str>) {
        let mut map = self
            .activated_by_scope
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(id) = scope_id {
            map.remove(id);
        } else {
            map.clear();
        }
    }

    pub fn clear_session(&self, session_id: &str) {
        let prefix = format!("{}:", session_id);
        let mut map = self
            .activated_by_scope
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        map.retain(|k, _| !k.starts_with(&prefix));
    }
}
