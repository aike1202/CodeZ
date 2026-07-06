// src/main/services/prompts/PromptBuilder.ts
//
// 注册顺序 = Agent 生命周期顺序（非功能分类）。
// Transformer 顺序阅读 Prompt，顺序直接影响规则遵守概率：
//
//   收到任务 → 理解任务 → 决定怎么办 → 调查 → 修改 → 验证 → 汇报
//
// 新增/移除模块只需改此文件。

import { PromptPipeline } from './PromptPipeline'

// ── 1. 身份 & 安全 ──────────────────────────
import { IdentityModule } from './core/Identity'
import { SecurityModule } from './core/Security'

// ── 2. 运行环境 & 行为准则 ──────────────────
import { HarnessModule } from './core/Harness'
import { EngineeringPhilosophyModule } from './core/EngineeringPhilosophy'

// ── 3. 上下文 ──────────────────────────────
import { EnvironmentModule } from './context/Environment'
import { GitStatusModule } from './context/GitStatus'
import { RepositoryRulesModule } from './context/RepositoryRules'
import { ContextManagementModule } from './context/ContextManagement'
import { MemoryModule } from './context/Memory'
import { SkillsModule } from './context/Skills'

// ── 4. 决策 & 工具策略 ──────────────────────
import { ToolPolicyModule } from './execution/ToolPolicy'

// ── 5. 调查 ───────────────────────────────
import { InvestigationModule } from './execution/Investigation'

// ── 6. 编辑 ───────────────────────────────
import { EditingModule } from './execution/Editing'

// ── 7. 验证 ───────────────────────────────
import { VerificationModule } from './execution/Verification'

// ── 8. 完成 ───────────────────────────────
import { CompletionModule } from './execution/Completion'

// ── 9. 工作追踪（Task / Plan / Delegate）────
import { TaskManagementModule } from './execution/TaskManagement'
import { PlanModeModule } from './execution/PlanMode'
import { WorkerDelegationModule } from './execution/WorkerDelegation'

// ── 10. 动态注入 ───────────────────────────
import { AvailableToolsModule } from './dynamic/AvailableTools'
import { SubAgentsModule } from './dynamic/SubAgents'

export function createDefaultPipeline(): PromptPipeline {
  return new PromptPipeline()
    // 1. 身份 & 安全
    .register(IdentityModule)
    .register(SecurityModule)
    // 2. 运行环境 & 行为准则
    .register(HarnessModule)
    .register(EngineeringPhilosophyModule)
    // 3. 上下文
    .register(EnvironmentModule)
    .register(GitStatusModule)
    .register(RepositoryRulesModule)
    .register(ContextManagementModule)
    .register(MemoryModule)
    .register(SkillsModule)
    // 4. 决策 & 工具策略
    .register(ToolPolicyModule)
    // 5. 调查
    .register(InvestigationModule)
    // 6. 编辑
    .register(EditingModule)
    // 7. 验证
    .register(VerificationModule)
    // 8. 完成
    .register(CompletionModule)
    // 9. 工作追踪
    .register(TaskManagementModule)
    .register(PlanModeModule)
    .register(WorkerDelegationModule)
    // 10. 动态注入
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
