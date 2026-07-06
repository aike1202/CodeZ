import type { PromptModule, PromptContext } from '../PromptTypes'
import { ToolManager } from '../../../tools/ToolManager'

export const AvailableToolsModule: PromptModule = {
  id: 'available-tools',
  layer: 'dynamic',
  priority: 0,
  build: () => {
    const tools = new ToolManager().getAllTools()
    const lines: string[] = []
    lines.push('<available_tools>')
    for (const tool of tools) {
      lines.push(`- ${tool.name}: ${tool.summary}`)
    }
    lines.push('</available_tools>')
    return lines.join('\n')
  },
}
