// src/main/services/prompts/PromptTypes.ts

export type PromptLayer = 'core' | 'context' | 'execution' | 'dynamic' | 'reminder'

export const LAYER_ORDER: Record<PromptLayer, number> = {
  core: 0,
  context: 1,
  execution: 2,
  dynamic: 3,
  reminder: 4,
}

export interface PromptModule {
  /** 唯一标识，用于版本追踪和日志 */
  readonly id: string
  /** 所属层级 */
  readonly layer: PromptLayer
  /** 层级内排序优先级（越小越靠前） */
  readonly priority: number
  /** 启用条件：返回 true 才注入；省略则始终启用。可同步或异步。 */
  isEnabled?(ctx: PromptContext): boolean | Promise<boolean>
  /** 构建文本内容 */
  build(ctx: PromptContext): string | Promise<string>
}

export interface PromptContext {
  workspaceRoot: string
  modelId: string
  modelDisplayName: string
  contextWindowTokens: number
  sessionId?: string
}
