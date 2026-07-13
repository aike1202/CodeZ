import { assembleSystemPrompt, buildSystemReminder } from './prompts'
import type { PromptContext } from './prompts'
import { resolvePromptContext } from './prompts/PromptContextResolver'
import { ToolManager } from '../tools/ToolManager'
import { getToolExposureState } from '../tools/runtime/ToolExposurePlanner'

function resolveMainTools(ctx: PromptContext): Pick<PromptContext, 'availableTools' | 'deferredTools'> {
  if (ctx.availableTools !== undefined && ctx.deferredTools !== undefined) {
    return { availableTools: ctx.availableTools, deferredTools: ctx.deferredTools }
  }
  const manager = new ToolManager()
  if (typeof (manager as any).createCatalogSnapshot !== 'function') {
    const tools = (manager as any).getAllTools?.() || []
    return {
      availableTools: tools.map((tool: any) => ({
        name: tool.name,
        summary: tool.summary || tool.description || ''
      })),
      deferredTools: []
    }
  }
  const catalog = manager.createCatalogSnapshot('main', ctx.workspaceRoot)
  const exposure = manager.createExposurePlan({
    catalog,
    agentRole: 'main',
    workspaceRoot: ctx.workspaceRoot,
    activatedDeferredTools: ctx.sessionId
      ? getToolExposureState().get(`${ctx.sessionId}:main`)
      : undefined
  })
  return {
    availableTools: exposure.eagerTools.map(tool => ({ name: tool.name, summary: tool.summary })),
    deferredTools: exposure.deferredTools.map(tool => ({ name: tool.name, summary: tool.summary }))
  }
}

export type { PromptContext } from './prompts'

/**
 * Backward-compatible facade. All prompt-text logic lives in ./prompts/.
 */
export class SystemPromptService {
  static async buildSystemPrompt(ctx: PromptContext): Promise<string> {
    return assembleSystemPrompt(await resolvePromptContext(
      { ...ctx, ...resolveMainTools(ctx) },
      { includeGit: true }
    ))
  }

  static async buildSystemReminder(workspaceRoot: string): Promise<string> {
    return buildSystemReminder(workspaceRoot)
  }
}
