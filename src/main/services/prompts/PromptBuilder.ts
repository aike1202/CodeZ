// src/main/services/prompts/PromptBuilder.ts
//
// 注册顺序 = Agent 生命周期顺序。
// Transformer 顺序阅读 Prompt，顺序直接影响规则遵守概率：
//
//   Layer 1 Core (Identity) → Layer 2 Context (Knowledge) → Layer 3 Execution → Layer 4 Dynamic
//
// 新增/移除模块只需改此文件。

import { PromptPipeline } from './PromptPipeline'

// ── Layer 1: Core — Identity & Thinking ─────────
import { IdentityModule } from './core/Identity'
import { SecurityModule } from './core/Security'
import { HarnessModule } from './core/Harness'
import { EngineeringPhilosophyModule } from './core/EngineeringPhilosophy'
import { ReasoningPolicyModule } from './core/ReasoningPolicy'
import { DecisionPolicyModule } from './core/DecisionPolicy'

// ── Layer 2: Context — Knowledge & Environment ──
import { MemoryModule } from './context/Memory'
import { ContextManagementModule } from './context/ContextManagement'
import { RepositoryRulesModule } from './context/RepositoryRules'
import { EnvironmentModule } from './context/Environment'
import { GitStatusModule } from './context/GitStatus'
import { SkillsModule } from './context/Skills'

// ── Layer 3: Execution — Action Policies ─────────
// 顺序 = Agent 执行管线：Investigate → Edit → Verify → Recover → Complete
import { InvestigationModule } from './execution/Investigation'
import { EditingModule } from './execution/Editing'
import { VerificationModule } from './execution/Verification'
import { FailureRecoveryModule } from './execution/FailureRecovery'
import { CompletionModule } from './execution/Completion'
// ── Layer 3: Execution — Workflow Gates ──────────
import { TaskManagementModule } from './execution/TaskManagement'
import { WorkerDelegationModule } from './execution/WorkerDelegation'
// ── Layer 3: Execution — Support ─────────────────
import { ToolPolicyModule } from './execution/ToolPolicy'
import { OutputPolicyModule } from './execution/OutputPolicy'

// ── Layer 4: Dynamic — Runtime Injection ─────────
import { AvailableToolsModule } from './dynamic/AvailableTools'
import { SubAgentsModule } from './dynamic/SubAgents'

export function createDefaultPipeline(): PromptPipeline {
  return new PromptPipeline()
    // Layer 1: Core — Identity & Thinking
    .register(IdentityModule)
    .register(SecurityModule)
    .register(HarnessModule)
    .register(EngineeringPhilosophyModule)
    .register(ReasoningPolicyModule)
    .register(DecisionPolicyModule)
    // Layer 2: Context — Knowledge & Environment
    .register(MemoryModule)
    .register(ContextManagementModule)
    .register(RepositoryRulesModule)
    .register(EnvironmentModule)
    .register(GitStatusModule)
    .register(SkillsModule)
    // Layer 3: Execution — Action Pipeline
    .register(InvestigationModule)
    .register(EditingModule)
    .register(VerificationModule)
    .register(FailureRecoveryModule)
    .register(CompletionModule)
    // Layer 3: Execution — Workflow Gates
    .register(TaskManagementModule)
    .register(WorkerDelegationModule)
    // Layer 3: Execution — Support
    .register(ToolPolicyModule)
    .register(OutputPolicyModule)
    // Layer 4: Dynamic — Runtime Injection
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
