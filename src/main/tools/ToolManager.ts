import { Tool } from './Tool'
import { ListFilesTool } from './builtin/ListFilesTool'
import { ReadFileTool } from './builtin/ReadFileTool'
import { SearchTextTool } from './builtin/SearchTextTool'
import { GetProjectSnapshotTool } from './builtin/GetProjectSnapshotTool'
import { ReadManyFilesTool } from './builtin/ReadManyFilesTool'
import { SearchCodeTool } from './builtin/SearchCodeTool'
import { GetSymbolMapTool } from './builtin/GetSymbolMapTool'
import { RollbackLastEditTool } from './builtin/RollbackLastEditTool'
import { WriteToFileTool } from './builtin/WriteToFileTool'
import { ReplaceFileContentTool } from './builtin/ReplaceFileContentTool'
import { RunCommandTool } from './builtin/RunCommandTool'
import { FastContextTool } from './builtin/FastContextTool'
import type { ToolDefinition } from '../../shared/types/provider'

export class ToolManager {
  private tools: Map<string, Tool> = new Map()

  constructor() {
    this.registerBuiltinTools()
  }

  private registerBuiltinTools() {
    const builtinTools = [
      new ListFilesTool(),
      new ReadFileTool(),
      new SearchTextTool(),
      new GetProjectSnapshotTool(),
      new ReadManyFilesTool(),
      new SearchCodeTool(),
      new GetSymbolMapTool(),
      new RollbackLastEditTool(),
      new WriteToFileTool(),
      new ReplaceFileContentTool(),
      new RunCommandTool(),
      new FastContextTool()
    ]
    
    for (const tool of builtinTools) {
      this.tools.set(tool.name, tool)
    }
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  getAllTools(): Tool[] {
    return Array.from(this.tools.values())
  }

  /** 返回兼容 OpenAI 等模型格式的 Tool Definitions 列表 */
  getToolDefinitions(): ToolDefinition[] {
    return this.getAllTools().map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters_schema
      }
    }))
  }
}
