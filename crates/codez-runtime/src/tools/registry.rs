use std::pin::Pin;
use std::future::Future;
use serde_json::Value;

use crate::tools::types::{
    AgentRole, ToolApprovalMetadata, ToolAvailabilityContext, ToolConcurrency, ToolEffectPlan, 
    ToolExecutionResult, ToolExposure, ToolInterruptBehavior, ToolPlanningContext, ToolSource
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
    fn aliases(&self) -> Vec<&'static str> { vec![] }
    fn version(&self) -> &'static str;
    fn source(&self) -> ToolSource;
    fn source_id(&self) -> String;
    fn summary(&self) -> String;
    fn description(&self) -> String;
    fn search_hint(&self) -> Option<String> { None }
    fn input_schema(&self) -> Value;
    fn output_schema(&self) -> Option<Value> { None }
    fn approval(&self) -> ToolApprovalMetadata;
    fn availability(&self) -> ToolAvailability;
    fn behavior(&self) -> ToolBehavior;

    // Checks dynamically
    fn is_enabled(&self, _context: &ToolAvailabilityContext) -> bool { true }
    fn is_read_only(&self, _input: &Value) -> bool { false }
    fn is_destructive(&self, _input: &Value) -> bool { false }

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
pub struct ToolContext {
    pub execution_id: String,
    pub session_id: String,
    // Add CancellationToken or other context handles here
}

pub trait ToolHandler: Send + Sync {
    fn descriptor(&self) -> &dyn ToolDescriptor;

    fn execute<'a>(
        &'a self,
        input: &'a Value,
        context: &'a ToolContext,
    ) -> BoxFuture<'a, ToolExecutionResult>;
}
