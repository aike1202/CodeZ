// src/main/services/prompts/index.ts
import { RulesResolver } from '../../agent/RulesResolver'
import type { PromptContext } from './types'

import { buildIdentity } from './sections/Identity'
import { buildSecurity } from './sections/Security'
import { buildHarness } from './sections/Harness'
import { buildMemory } from './sections/Memory'
import { buildContextManagement } from './sections/ContextManagement'
import { buildDeveloperInstructions } from './sections/DeveloperInstructions'
import { buildRepositoryInstructions } from './sections/RepositoryInstructions'
import { buildEnvironment } from './sections/Environment'
import { buildGitStatus } from './sections/GitStatus'
import { buildAvailableTools } from './sections/AvailableTools'
import { buildPendingFeatures } from './sections/PendingFeatures'
import { buildSkills } from './sections/Skills'

export type { PromptContext } from './types'

export async function assembleSystemPrompt(ctx: PromptContext): Promise<string> {
  const sections: string[] = []

  sections.push(buildIdentity())
  sections.push(buildSecurity())
  sections.push(buildHarness())
  sections.push(buildMemory(ctx.workspaceRoot))
  sections.push(buildContextManagement())

  const devInstructions = await buildDeveloperInstructions(ctx.workspaceRoot)
  sections.push(devInstructions)

  const repoRules = await buildRepositoryInstructions(ctx.workspaceRoot)
  if (repoRules) sections.push(repoRules)

  sections.push(buildEnvironment(ctx))
  sections.push(buildGitStatus(ctx.workspaceRoot))
  sections.push(buildAvailableTools())
  sections.push(buildPendingFeatures())

  const skills = await buildSkills(ctx.workspaceRoot)
  if (skills) sections.push(skills)

  return sections.filter(Boolean).join('\n\n')
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
