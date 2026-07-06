import type { PromptModule, PromptContext } from '../PromptTypes'

export const RuntimeHintsModule: PromptModule = {
  id: 'runtime-hints',
  layer: 'dynamic',
  priority: 4,
  isEnabled: (ctx: PromptContext) => ctx.contextWindowTokens < 128000,
  build: (ctx: PromptContext) => {
    const pct = ctx.contextWindowTokens < 64000 ? 'small' : 'moderate'
    return `<runtime_hints>
Context window: ${ctx.contextWindowTokens} tokens (${pct}).
Prefer delegating exploration to subagents. Be concise.
</runtime_hints>`
  },
}
