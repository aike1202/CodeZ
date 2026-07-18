use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use codez_core::{CancellationToken, FileSystem};
use serde_json::Value;

use crate::tools::types::{
    AgentRole, DeferredToolSummary, ToolApprovalMetadata, ToolAvailabilityContext, ToolConcurrency,
    ToolEffectPlan, ToolExecutionResult, ToolExposure, ToolInterruptBehavior, ToolPlanningContext,
    ToolSource,
};
use crate::{
    edit_transaction::EditTransactionService, fingerprint::ReadFingerprintStore,
    mutation_coordinator::FileMutationCoordinator,
};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone)]
pub struct ToolAvailability {
    pub roles: Option<Vec<AgentRole>>, // None means '*'
    pub platforms: Option<Vec<String>>,
    pub exposure: ToolExposure,
}

#[derive(Debug, Clone)]
pub struct ToolBehavior {
    pub concurrency: ToolConcurrency,
    pub interrupt: ToolInterruptBehavior,
    pub max_result_chars: u32,
    pub timeout_ms: Option<u32>,
}

pub trait ToolDescriptor: Send + Sync + std::fmt::Debug {
    fn name(&self) -> &'static str;
    fn aliases(&self) -> Vec<&'static str> {
        Vec::new()
    }
    fn version(&self) -> &'static str;
    fn source(&self) -> ToolSource;
    fn source_id(&self) -> String;
    fn summary(&self) -> String;
    fn description(&self) -> String;
    fn search_hint(&self) -> Option<String> {
        None
    }
    fn input_schema(&self) -> Value;
    fn output_schema(&self) -> Option<Value> {
        None
    }
    fn approval(&self) -> ToolApprovalMetadata;
    fn availability(&self) -> ToolAvailability;
    fn behavior(&self) -> ToolBehavior;

    // Checks dynamically
    fn is_enabled(&self, _context: &ToolAvailabilityContext) -> bool {
        true
    }
    fn is_read_only(&self, _input: &Value) -> bool {
        false
    }
    fn is_destructive(&self, _input: &Value) -> bool {
        false
    }

    fn plan_effects<'a>(
        &'a self,
        _input: &'a Value,
        _context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, ToolEffectPlan>;

    fn resource_keys<'a>(
        &'a self,
        _input: &'a Value,
        _context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, Vec<String>>;
}

#[derive(Debug, Clone)]
pub struct DefaultToolDescriptor {
    pub name: &'static str,
    pub version: &'static str,
    pub source: ToolSource,
    pub source_id: String,
    pub summary: String,
    pub description: String,
    pub input_schema: Value,
    pub approval: ToolApprovalMetadata,
    pub availability: ToolAvailability,
    pub behavior: ToolBehavior,
}

impl ToolDescriptor for DefaultToolDescriptor {
    fn name(&self) -> &'static str {
        self.name
    }
    fn version(&self) -> &'static str {
        self.version
    }
    fn source(&self) -> ToolSource {
        self.source.clone()
    }
    fn source_id(&self) -> String {
        self.source_id.clone()
    }
    fn summary(&self) -> String {
        self.summary.clone()
    }
    fn description(&self) -> String {
        self.description.clone()
    }
    fn input_schema(&self) -> Value {
        self.input_schema.clone()
    }
    fn approval(&self) -> ToolApprovalMetadata {
        self.approval.clone()
    }
    fn availability(&self) -> ToolAvailability {
        self.availability.clone()
    }
    fn behavior(&self) -> ToolBehavior {
        self.behavior.clone()
    }

    fn plan_effects<'a>(
        &'a self,
        _input: &'a Value,
        _context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, ToolEffectPlan> {
        Box::pin(async {
            ToolEffectPlan {
                effects: vec![crate::tools::types::ToolEffect::Unknown {
                    target: "descriptor-did-not-classify-effects".to_string(),
                }],
                analysis_status: "unparsed".to_string(),
            }
        })
    }

    fn resource_keys<'a>(
        &'a self,
        _input: &'a Value,
        _context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async { Vec::new() })
    }
}

#[derive(Clone)]
pub struct ToolFileServices {
    pub file_system: Arc<dyn FileSystem>,
    pub fingerprint_store: Arc<ReadFingerprintStore>,
    pub mutation_coordinator: Arc<FileMutationCoordinator>,
    pub edit_transaction_service: Arc<EditTransactionService>,
}

#[derive(Clone)]
pub struct ToolContext {
    pub execution_id: String,
    pub call_id: String,
    pub turn_id: Option<String>,
    pub session_id: Option<String>,
    pub context_scope_id: String,
    pub transaction_id: Option<String>,
    pub workspace_root: PathBuf,
    pub cancellation: CancellationToken,
    pub authorized_effects: ToolEffectPlan,
    pub file_services: Option<ToolFileServices>,
    pub deferred_tools: Vec<DeferredToolSummary>,
}

pub trait ToolHandler: Send + Sync {
    fn descriptor(&self) -> &dyn ToolDescriptor;

    fn normalize_input(&self, input: Value) -> Value {
        input
    }

    fn plan_effects<'a>(
        &'a self,
        input: &'a Value,
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, ToolEffectPlan> {
        self.descriptor().plan_effects(input, context)
    }

    fn resource_keys<'a>(
        &'a self,
        input: &'a Value,
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, Vec<String>> {
        self.descriptor().resource_keys(input, context)
    }

    fn execute<'a>(
        &'a self,
        input: &'a Value,
        context: &'a ToolContext,
    ) -> BoxFuture<'a, ToolExecutionResult>;
}
