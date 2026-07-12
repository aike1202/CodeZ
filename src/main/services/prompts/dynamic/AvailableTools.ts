import type { PromptModule, PromptContext } from '../PromptTypes'
import { ToolManager } from '../../../tools/ToolManager'
import { getToolExposureState } from '../../../tools/runtime/ToolExposurePlanner'
import { getMcpInstructionRegistry } from '../../mcp/McpInstructionRegistry'

export const AvailableToolsModule: PromptModule = {
  id: 'available-tools',
  layer: 'dynamic',
  priority: 0,
  build: (context: PromptContext) => {
    const manager = new ToolManager()
    if (typeof (manager as any).createCatalogSnapshot !== 'function') {
      const tools = (manager as any).getAllTools?.() || []
      return [
        '<deferred_tools>',
        ...tools.map((tool: any) => `- ${tool.name}: ${tool.summary || tool.description || ''}`),
        '</deferred_tools>'
      ].join('\n')
    }
    const catalog = manager.createCatalogSnapshot('main', context.workspaceRoot)
    const exposure = manager.createExposurePlan({
      catalog,
      agentRole: 'main',
      workspaceRoot: context.workspaceRoot,
      activatedDeferredTools: context.sessionId
        ? getToolExposureState().get(`${context.sessionId}:main`)
        : undefined
    })
    const lines: string[] = []
    if (exposure.deferredTools.length > 0) {
      lines.push('<deferred_tools>')
      lines.push('Use ToolSearch to activate one of these capabilities for the next turn:')
      for (const tool of exposure.deferredTools) {
        lines.push(`- ${tool.name}: ${tool.summary}`)
      }
      lines.push('</deferred_tools>')
    }
    const mcpInstructions = getMcpInstructionRegistry().render()
    if (mcpInstructions) lines.push(mcpInstructions)
    return lines.join('\n')
  },
}
