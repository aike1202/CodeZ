import { PromptPipeline } from './PromptPipeline'
import type { PromptContext, PromptModule } from './PromptTypes'
import { resolvePromptContext } from './PromptContextResolver'

import { IdentityModule } from './core/Identity'
import { SecurityModule } from './core/Security'
import { HarnessModule } from './core/Harness'
import { EngineeringPhilosophyModule } from './core/EngineeringPhilosophy'
import { ContextManagementModule } from './context/ContextManagement'
import { RepositoryRulesModule } from './context/RepositoryRules'
import { EnvironmentModule } from './context/Environment'
import { SkillsModule } from './context/Skills'
import { VerificationStrategyModule } from './context/VerificationStrategy'
import { InvestigationModule } from './execution/Investigation'
import { EditingModule } from './execution/Editing'
import { VerificationModule } from './execution/Verification'
import { FailureRecoveryModule } from './execution/FailureRecovery'
import { ToolPolicyModule } from './execution/ToolPolicy'
import { OutputPolicyModule } from './execution/OutputPolicy'

export const SHARED_TOOL_USE_MODULES: PromptModule[] = [
  SecurityModule,
  HarnessModule,
  InvestigationModule,
  ToolPolicyModule,
]

export async function buildSharedToolUsePrompt(ctx: PromptContext): Promise<string> {
  return new PromptPipeline().registerAll(SHARED_TOOL_USE_MODULES).run(ctx)
}

function createExecutorPipeline(): PromptPipeline {
  return new PromptPipeline()
    .register(IdentityModule)
    .registerAll(SHARED_TOOL_USE_MODULES)
    .register(EngineeringPhilosophyModule)
    .register(FailureRecoveryModule)
    .register(ContextManagementModule)
    .register(RepositoryRulesModule)
    .register(EnvironmentModule)
    .register(SkillsModule)
    .register(VerificationStrategyModule)
    .register(EditingModule)
    .register(VerificationModule)
    .register(OutputPolicyModule)
}

export async function buildExecutorSharedPrompt(ctx: PromptContext): Promise<string> {
  return createExecutorPipeline().run(await resolvePromptContext(ctx))
}
