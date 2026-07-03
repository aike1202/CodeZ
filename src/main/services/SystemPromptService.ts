import { assembleSystemPrompt, buildSystemReminder } from './prompts'
import type { PromptContext } from './prompts'

export type { PromptContext } from './prompts'

/**
 * Backward-compatible facade. All prompt-text logic lives in ./prompts/.
 */
export class SystemPromptService {
  static async buildSystemPrompt(ctx: PromptContext): Promise<string> {
    return assembleSystemPrompt(ctx)
  }

  static async buildSystemReminder(workspaceRoot: string): Promise<string> {
    return buildSystemReminder(workspaceRoot)
  }
}
