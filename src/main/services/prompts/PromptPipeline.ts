// src/main/services/prompts/PromptPipeline.ts

import type { PromptContext, PromptModule, PromptLayer } from './PromptTypes'
import { LAYER_ORDER } from './PromptTypes'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './PromptCache'

export class PromptPipeline {
  private modules: PromptModule[] = []

  /** 注册一个 PromptModule。重复 id 的后者覆盖前者。 */
  register(m: PromptModule): this {
    const idx = this.modules.findIndex(existing => existing.id === m.id)
    if (idx >= 0) {
      this.modules[idx] = m
    } else {
      this.modules.push(m)
    }
    return this
  }

  /** 批量注册。 */
  registerAll(modules: PromptModule[]): this {
    for (const m of modules) {
      this.register(m)
    }
    return this
  }

  private sortedModules(): PromptModule[] {
    return [...this.modules].sort((a, b) => {
      const layerDiff = LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer]
      if (layerDiff !== 0) return layerDiff
      return a.priority - b.priority
    })
  }

  /** 执行完整流程：排序 → 并行解析 → 分离稳定前缀与动态上下文。 */
  async run(ctx: PromptContext): Promise<string> {
    const resolved = await Promise.all(this.sortedModules().map(async (m) => {
      const enabled = m.isEnabled ? await m.isEnabled(ctx) : true
      if (!enabled) return null
      const text = await m.build(ctx)
      if (!text?.trim()) return null
      return { module: m, text: text.trim() }
    }))

    const active = resolved.filter((item): item is NonNullable<typeof item> => item !== null)
    const staticSections = active
      .filter(({ module }) => module.layer === 'core' || module.layer === 'execution')
      .map(({ text }) => text)
    const dynamicSections = active
      .filter(({ module }) => module.layer !== 'core' && module.layer !== 'execution')
      .map(({ text }) => text)

    if (staticSections.length === 0) return dynamicSections.join('\n\n')
    if (dynamicSections.length === 0) return staticSections.join('\n\n')
    return [
      staticSections.join('\n\n'),
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      dynamicSections.join('\n\n')
    ].join('\n\n')
  }

  /** 调试用：列出当前启用的模块 id。 */
  async listEnabled(ctx: PromptContext): Promise<Array<{ id: string; layer: PromptLayer; priority: number }>> {
    const modules = this.sortedModules()
    const enabled = await Promise.all(modules.map(m => m.isEnabled ? m.isEnabled(ctx) : true))
    return modules
      .filter((_module, index) => enabled[index])
      .map(module => ({ id: module.id, layer: module.layer, priority: module.priority }))
  }
}
