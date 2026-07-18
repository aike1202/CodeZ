// src/main/services/prompts/PromptBuilder.ts
//
// 注册顺序 = Agent 生命周期顺序。
// Transformer 顺序阅读 Prompt，顺序直接影响规则遵守概率：
//
//   Stable behavior (Core + Execution) → session/turn Context → Dynamic capabilities
//
// 新增/移除模块只需改此文件。

import { PromptPipeline } from './PromptPipeline'

// ── Layer 1: Core — Identity & Thinking ─────────
import { IdentityModule } from './core/Identity'
import { EngineeringPhilosophyModule } from './core/EngineeringPhilosophy'

// ── Layer 2: Context — Knowledge & Environment ──
import { MemoryModule } from './context/Memory'
import { ContextManagementModule } from './context/ContextManagement'
import { RepositoryRulesModule } from './context/RepositoryRules'
import { EnvironmentModule } from './context/Environment'
import { GitStatusModule } from './context/GitStatus'
import { SkillsModule } from './context/Skills'
import { VerificationStrategyModule } from './context/VerificationStrategy'

// ── Layer 3: Execution — Action Policies ─────────
// 顺序 = Agent 执行管线：Investigate → Edit → Verify → Recover → Complete
import { EditingModule } from './execution/Editing'
import { VerificationModule } from './execution/Verification'
import { WorkerDelegationModule } from './execution/WorkerDelegation'
// ── Layer 3: Execution — Support ─────────────────
import { OutputPolicyModule } from './execution/OutputPolicy'
import { SHARED_TOOL_USE_MODULES } from './SubAgentPrompts'

// ── Layer 4: Dynamic — Runtime Injection ─────────
import { AvailableToolsModule } from './dynamic/AvailableTools'
import { SubAgentsModule } from './dynamic/SubAgents'

export function createDefaultPipeline(): PromptPipeline {
  return new PromptPipeline()
    // Layer 1: Core — Identity & Thinking
    .register(IdentityModule)
    .registerAll(SHARED_TOOL_USE_MODULES)
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
    .register(WorkerDelegationModule)
    // Layer 3: Execution — Support
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
