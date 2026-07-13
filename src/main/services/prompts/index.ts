// src/main/services/prompts/index.ts
//
// Prompt v3 — stable behavior prefix + dynamic runtime context
//
// assembleSystemPrompt() 通过 PromptBuilder → PromptPipeline 组装：
//   - Layer 1 Core: Identity, Security, Harness, EngineeringPhilosophy
//   - Layer 2 Context: Memory, ContextManagement, RepositoryRules, Environment, GitStatus, Skills
//   - Layer 3 Execution: Investigation, Editing, Verification, ToolPolicy,
//                        TaskManagement, WorkerDelegation, OutputPolicy
//   - Layer 4 Dynamic: AvailableTools, SubAgents
//
// Public API remains backward compatible for callers that consume a string prompt.

import { getPipeline } from './PromptBuilder'
import type { PromptContext } from './PromptTypes'

export type { PromptContext } from './PromptTypes'

export { getPipeline, resetPipelineCache, createDefaultPipeline } from './PromptBuilder'
export { PromptPipeline } from './PromptPipeline'
export type { PromptModule, PromptLayer } from './PromptTypes'
export {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  splitSystemPromptSections,
  stripSystemPromptMarkers
} from './PromptCache'

export async function assembleSystemPrompt(ctx: PromptContext): Promise<string> {
  return getPipeline().run(ctx)
}

export async function buildSystemReminder(_workspaceRoot: string): Promise<string> {
  // Global rules now share one explicit precedence chain with workspace rules.
  return ''
}
