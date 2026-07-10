import { PromptPipeline } from './PromptPipeline'
import type { PromptContext } from './PromptTypes'

import { IdentityModule } from './core/Identity'
import { SecurityModule } from './core/Security'
import { HarnessModule } from './core/Harness'
import { EngineeringPhilosophyModule } from './core/EngineeringPhilosophy'
import { ReasoningPolicyModule } from './core/ReasoningPolicy'
import { DecisionPolicyModule } from './core/DecisionPolicy'
import { ContextManagementModule } from './context/ContextManagement'
import { RepositoryRulesModule } from './context/RepositoryRules'
import { EnvironmentModule } from './context/Environment'
import { GitStatusModule } from './context/GitStatus'
import { SkillsModule } from './context/Skills'
import { InvestigationModule } from './execution/Investigation'
import { EditingModule } from './execution/Editing'
import { VerificationModule } from './execution/Verification'
import { FailureRecoveryModule } from './execution/FailureRecovery'
import { ToolPolicyModule } from './execution/ToolPolicy'
import { OutputPolicyModule } from './execution/OutputPolicy'

function createExecutorPipeline(): PromptPipeline {
  return new PromptPipeline()
    .register(IdentityModule)
    .register(SecurityModule)
    .register(HarnessModule)
    .register(EngineeringPhilosophyModule)
    .register(ReasoningPolicyModule)
    .register(DecisionPolicyModule)
    .register(ContextManagementModule)
    .register(RepositoryRulesModule)
    .register(EnvironmentModule)
    .register(GitStatusModule)
    .register(SkillsModule)
    .register(InvestigationModule)
    .register(EditingModule)
    .register(VerificationModule)
    .register(FailureRecoveryModule)
    .register(ToolPolicyModule)
    .register(OutputPolicyModule)
}

export async function buildExecutorSharedPrompt(ctx: PromptContext): Promise<string> {
  return createExecutorPipeline().run(ctx)
}
