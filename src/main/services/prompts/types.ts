// src/main/services/prompts/types.ts
export interface PromptContext {
  workspaceRoot: string
  modelId: string
  modelDisplayName: string
  contextWindowTokens: number
  sessionId?: string
}
