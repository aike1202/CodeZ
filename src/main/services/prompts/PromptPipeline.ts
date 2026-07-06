// src/main/services/prompts/PromptPipeline.ts

import type { PromptContext, PromptModule, PromptLayer } from './PromptTypes'
import { LAYER_ORDER } from './PromptTypes'

interface RegisteredModule {
  module: PromptModule
  enabled: boolean
}

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

  /** 执行完整流程：过滤 → 排序 → 构建 → 拼接 → 追加版本标记。 */
  async run(ctx: PromptContext): Promise<string> {
    const resolved: RegisteredModule[] = []
    for (const m of this.modules) {
      const enabled = m.isEnabled ? await m.isEnabled(ctx) : true
      if (enabled) resolved.push({ module: m, enabled })
    }

    resolved.sort((a, b) => {
      const layerDiff = LAYER_ORDER[a.module.layer] - LAYER_ORDER[b.module.layer]
      if (layerDiff !== 0) return layerDiff
      return a.module.priority - b.module.priority
    })

    const sections: string[] = []
    for (const reg of resolved) {
      const text = await reg.module.build(ctx)
      if (text && text.trim()) {
        sections.push(text.trim())
      }
    }

    const ids = resolved.map(r => r.module.id).join(',')
    const layers = [...new Set(resolved.map(r => r.module.layer))].join('/')
    const versionTag = `<!-- prompt:v2.0 layers:${layers} enabled:${ids} -->`

    return sections.join('\n\n') + '\n\n' + versionTag
  }

  /** 调试用：列出当前启用的模块 id。 */
  listEnabled(ctx: PromptContext): Array<{ id: string; layer: PromptLayer; priority: number }> {
    return this.modules
      .filter(m => (m.isEnabled ? m.isEnabled(ctx) : true))
      .sort((a, b) => {
        const layerDiff = LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer]
        if (layerDiff !== 0) return layerDiff
        return a.priority - b.priority
      })
      .map(m => ({ id: m.id, layer: m.layer, priority: m.priority }))
  }
}
