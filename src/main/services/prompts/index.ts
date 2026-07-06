// src/main/services/prompts/index.ts
//
// Prompt v2 — 分层 Pipeline 架构
//
// assembleSystemPrompt() 通过 PromptBuilder → PromptPipeline 组装：
//   - Core: Identity, Security, Harness（决策原则已合并进 Harness）
//   - Context: Memory, ContextMgmt, RepoRules, Environment, GitStatus, Skills
//   - Execution: ToolPolicy, Editing, Verification, Task, Plan, Worker, Completion
//   - Dynamic: AvailableTools, SubAgents
//
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
