// src/main/services/prompts/sections/Environment.ts
import * as os from 'os'
import type { PromptContext } from '../types'

export function buildEnvironment(ctx: PromptContext): string {
  const platform = process.platform
  const shell = platform === 'win32'
    ? 'PowerShell (primary); Bash tool also available for POSIX scripts'
    : 'Bash'

  return [
    '<environment_context>',
    `  <cwd>${ctx.workspaceRoot}</cwd>`,
    `  <shell>${shell}</shell>`,
    `  <os>${os.type()} ${os.release()}</os>`,
    `  <platform>${platform}</platform>`,
    `  <date>${new Date().toISOString().slice(0, 10)}</date>`,
    `  <model>${ctx.modelDisplayName}</model>`,
    `  <model_id>${ctx.modelId}</model_id>`,
    `  <context_window>${ctx.contextWindowTokens} tokens</context_window>`,
    `  <knowledge_cutoff>January 2026</knowledge_cutoff>`,
    '</environment_context>'
  ].join('\n')
}
