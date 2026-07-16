use std::sync::Arc;
use crate::chat::prompt::pipeline::PromptPipeline;
use crate::chat::prompt::modules::{
    identity::IdentityModule,
    engineering_philosophy::EngineeringPhilosophyModule,
    memory::MemoryModule,
    context_management::ContextManagementModule,
    repository_rules::RepositoryRulesModule,
    environment::EnvironmentModule,
    git_status::GitStatusModule,
    skills::SkillsModule,
    verification_strategy::VerificationStrategyModule,
    editing::EditingModule,
    verification::VerificationModule,
    task_management::TaskManagementModule,
    worker_delegation::WorkerDelegationModule,
    output_policy::OutputPolicyModule,
    available_tools::AvailableToolsModule,
    sub_agents::SubAgentsModule,
};

pub fn create_default_pipeline() -> PromptPipeline {
    PromptPipeline::new()
        // Layer 1: Core — Identity & Thinking
        .register(IdentityModule)
        .register(EngineeringPhilosophyModule)
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
        // Layer 3: Execution — Workflow Gates
        .register(TaskManagementModule)
        .register(WorkerDelegationModule)
        // Layer 3: Execution — Support
        .register(OutputPolicyModule)
        // Layer 4: Dynamic — Runtime Injection
        .register(AvailableToolsModule)
        .register(SubAgentsModule)
}
