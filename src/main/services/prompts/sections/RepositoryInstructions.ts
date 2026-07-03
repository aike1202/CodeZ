// src/main/services/prompts/sections/RepositoryInstructions.ts
import { RulesResolver } from '../../../agent/RulesResolver'

export async function buildRepositoryInstructions(workspaceRoot: string): Promise<string> {
  const rules = await RulesResolver.getWorkspaceRules(workspaceRoot)
  if (!rules) return ''
  return `<repository_instructions>\n${rules}\n</repository_instructions>`
}
