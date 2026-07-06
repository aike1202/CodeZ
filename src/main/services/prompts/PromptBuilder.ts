// src/main/services/prompts/PromptBuilder.ts
//
// 注册所有 PromptModule 到 Pipeline。
// 新增/移除模块只需改此文件。

import { PromptPipeline } from './PromptPipeline'

// Core
import { IdentityModule } from './core/Identity'
import { SecurityModule } from './core/Security'
import { HarnessModule } from './core/Harness'

// Context
import { MemoryModule } from './context/Memory'
import { ContextManagementModule } from './context/ContextManagement'
import { RepositoryRulesModule } from './context/RepositoryRules'
import { EnvironmentModule } from './context/Environment'
import { GitStatusModule } from './context/GitStatus'
import { SkillsModule } from './context/Skills'

// Execution
import { ToolPolicyModule } from './execution/ToolPolicy'
import { EditingModule } from './execution/Editing'
import { VerificationModule } from './execution/Verification'
import { TaskManagementModule } from './execution/TaskManagement'
import { PlanModeModule } from './execution/PlanMode'
import { WorkerDelegationModule } from './execution/WorkerDelegation'
import { CompletionModule } from './execution/Completion'

// Dynamic
import { AvailableToolsModule } from './dynamic/AvailableTools'
import { SubAgentsModule } from './dynamic/SubAgents'

export function createDefaultPipeline(): PromptPipeline {
  return new PromptPipeline()
    // ── Core ──────────────────────────────────
    .register(IdentityModule)
    .register(SecurityModule)
    .register(HarnessModule)
    // ── Context ───────────────────────────────
    .register(MemoryModule)
    .register(ContextManagementModule)
    .register(RepositoryRulesModule)
    .register(EnvironmentModule)
    .register(GitStatusModule)
    .register(SkillsModule)
    // ── Execution ─────────────────────────────
    .register(ToolPolicyModule)
    .register(EditingModule)
    .register(VerificationModule)
    .register(TaskManagementModule)
    .register(PlanModeModule)
    .register(WorkerDelegationModule)
    .register(CompletionModule)
    // ── Dynamic ───────────────────────────────
    .register(AvailableToolsModule)
    .register(SubAgentsModule)
}

let cachedPipeline: PromptPipeline | null = null

export function getPipeline(): PromptPipeline {
  if (!cachedPipeline) {
    cachedPipeline = createDefaultPipeline()
  }
  return cachedPipeline
}

export function resetPipelineCache(): void {
  cachedPipeline = null
}
