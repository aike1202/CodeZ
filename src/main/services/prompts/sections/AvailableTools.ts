// src/main/services/prompts/sections/AvailableTools.ts
import { ToolManager } from '../../../tools/ToolManager'

export function buildAvailableTools(): string {
  const tm = new ToolManager()
  const allTools = tm.getAllTools()
  const lines: string[] = []
  lines.push('<available_tools>')
  lines.push("Below is the list of tools you have access to. Use them effectively to accomplish the user's task:")
  for (const tool of allTools) {
    lines.push(`- ${tool.name}: ${tool.description}`)
  }
  lines.push('</available_tools>')
  return lines.join('\n')
}
