use crate::chat::prompt::modules::{
    agent_runtime::{
        AgentAssignmentModule, AgentDelegationPolicyModule, AgentMailboxModule, AgentProfileModule,
        AgentResultContractModule, AgentRuntimeModule, AgentWorkspaceBudgetModule,
    },
    available_tools::AvailableToolsModule,
    context_management::ContextManagementModule,
    editing::EditingModule,
    engineering_philosophy::EngineeringPhilosophyModule,
    environment::EnvironmentModule,
    git_status::GitStatusModule,
    identity::IdentityModule,
    memory::MemoryModule,
    output_policy::OutputPolicyModule,
    repository_rules::RepositoryRulesModule,
    skills::SkillsModule,
    todo_management::TodoManagementModule,
    tool_usage::ToolUsageModule,
    verification::VerificationModule,
    verification_strategy::VerificationStrategyModule,
};
use crate::chat::prompt::pipeline::PromptPipeline;

pub fn create_default_pipeline() -> PromptPipeline {
    PromptPipeline::new()
        // Layer 1: Core — Identity & Thinking
        .register(IdentityModule)
        .register(EngineeringPhilosophyModule)
        .register(AgentRuntimeModule)
        // Layer 2: Context — Knowledge & Environment
        .register(MemoryModule)
        .register(ContextManagementModule)
        .register(RepositoryRulesModule)
        .register(EnvironmentModule)
        .register(GitStatusModule)
        .register(SkillsModule)
        .register(VerificationStrategyModule)
        // Layer 3: Execution — Action Pipeline
        .register(EditingModule)
        .register(VerificationModule)
        .register(AgentDelegationPolicyModule)
        .register(AgentProfileModule)
        // Layer 3: Execution — Workflow Gates
        .register(TodoManagementModule)
        // Layer 3: Execution — Support
        .register(OutputPolicyModule)
        // Layer 4: Dynamic — Runtime Injection
        .register(ToolUsageModule)
        .register(AvailableToolsModule)
        .register(AgentAssignmentModule)
        .register(AgentWorkspaceBudgetModule)
        .register(AgentMailboxModule)
        .register(AgentResultContractModule)
}
