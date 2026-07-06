// src/main/services/prompts/PromptBuilder.ts
//
// 注册所有 PromptModule 到 Pipeline。
// 新增/移除模块只需改 createDefaultPipeline() —— Pipeline 和 index.ts 都不动。

import { PromptPipeline } from './PromptPipeline'

// Core (always sent)
import { IdentityModule } from './core/Identity'
import { SecurityModule } from './core/Security'
import { HarnessModule } from './core/Harness'
import { ReasoningPolicyModule } from './core/ReasoningPolicy'
import { OutputPolicyModule } from './core/OutputPolicy'
import { CommunicationModule } from './core/Communication'

// Context (conditional)
import { MemoryModule } from './context/Memory'
import { ContextManagementModule } from './context/ContextManagement'
import { RepositoryRulesModule } from './context/RepositoryRules'
import { EnvironmentModule } from './context/Environment'
import { GitStatusModule } from './context/GitStatus'
import { SkillsModule } from './context/Skills'
import { ActivePlanModule } from './context/ActivePlan'

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
import { WorkspaceRulesModule } from './dynamic/WorkspaceRules'
import { UserRulesModule } from './dynamic/UserRules'
import { SubAgentsModule } from './dynamic/SubAgents'
import { RuntimeHintsModule } from './dynamic/RuntimeHints'

// Reminder
import { SystemReminderModule } from './reminder/SystemReminder'
import { TrimReminderModule } from './reminder/TrimReminder'

export function createDefaultPipeline(): PromptPipeline {
  return new PromptPipeline()
    // ── Core ──────────────────────────────────
    .register(IdentityModule)
    .register(SecurityModule)
    .register(HarnessModule)
    .register(ReasoningPolicyModule)
    .register(OutputPolicyModule)
    .register(CommunicationModule)
    // ── Context ───────────────────────────────
    .register(MemoryModule)
    .register(ContextManagementModule)
    .register(RepositoryRulesModule)   // workspace rules early
    .register(EnvironmentModule)
    .register(GitStatusModule)
    .register(SkillsModule)
    .register(ActivePlanModule)        // only when plan is active
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
    .register(WorkspaceRulesModule)
    .register(UserRulesModule)
    .register(SubAgentsModule)
    .register(RuntimeHintsModule)
    // ── Reminder ──────────────────────────────
    .register(SystemReminderModule)
    .register(TrimReminderModule)
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
