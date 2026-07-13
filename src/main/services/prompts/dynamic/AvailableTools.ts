import type { PromptModule, PromptContext } from '../PromptTypes'
import { getMcpInstructionRegistry } from '../../mcp/McpInstructionRegistry'

export const AvailableToolsModule: PromptModule = {
  id: 'available-tools',
  layer: 'dynamic',
  priority: 2,
  build: (context: PromptContext) => {
    const lines: string[] = []
    if (context.deferredTools?.length) {
      lines.push('<deferred_tools>')
      lines.push('Use ToolSearch to activate one of these capabilities for the next turn:')
      for (const tool of context.deferredTools) {
        lines.push(`- ${tool.name}: ${tool.summary}`)
      }
      lines.push('</deferred_tools>')
    }
    const mcpInstructions = getMcpInstructionRegistry().render()
    if (mcpInstructions) lines.push(mcpInstructions)
    return lines.join('\n')
  },
}
