// src/main/services/prompts/index.ts
//
// Prompt v2.1 — 分层 Pipeline 架构
//
// assembleSystemPrompt() 通过 PromptBuilder → PromptPipeline 组装：
//   - Layer 1 Core: Identity, Security, Harness, EngineeringPhilosophy, ReasoningPolicy, DecisionPolicy
//   - Layer 2 Context: Memory, ContextManagement, RepositoryRules, Environment, GitStatus, Skills
//   - Layer 3 Execution: Investigation, Editing, Verification, TaskManagement, ToolPolicy,
//                        FailureRecovery, TaskManagement, WorkerDelegation, Completion, OutputPolicy
//   - Layer 4 Dynamic: AvailableTools, SubAgents
//
// 每个 Section 统一遵循 Purpose / Policy / Exceptions / Never / Golden Rule 模板。
// 公共 API 保持不变，调用方无需修改。

import { getPipeline } from './PromptBuilder'
import { RulesResolver } from '../../agent/RulesResolver'
import type { PromptContext } from './PromptTypes'

export type { PromptContext } from './PromptTypes'

export { getPipeline, resetPipelineCache, createDefaultPipeline } from './PromptBuilder'
export { PromptPipeline } from './PromptPipeline'
export type { PromptModule, PromptLayer } from './PromptTypes'

export async function assembleSystemPrompt(ctx: PromptContext): Promise<string> {
  return getPipeline().run(ctx)
}

export async function buildSystemReminder(_workspaceRoot: string): Promise<string> {
  const globalRules = await RulesResolver.getGlobalRules()
  if (!globalRules) return ''

  const today = new Date().toISOString().slice(0, 10)
  return [
    '<system-reminder>',
    "As you answer the user's questions, you can use the following context:",
    '# claudeMd',
    'Codebase and user instructions are shown below. Be sure to adhere to these',
    'instructions. IMPORTANT: These instructions OVERRIDE any default behavior',
    'and you MUST follow them exactly as written.',
    '',
    globalRules,
    '',
    '# currentDate',
    `Today's date is ${today}.`,
    '',
    '      IMPORTANT: this context may or may not be relevant to your tasks.',
    '      You should not respond to this context unless it is highly relevant',
    '      to your task.',
    '</system-reminder>'
  ].join('\n')
}
