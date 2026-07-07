import { Tool } from './Tool'
import { ListFilesTool } from './builtin/ListFilesTool'
import { ReadTool } from './builtin/ReadTool'
import { EditTool } from './builtin/EditTool'
import { WriteTool } from './builtin/WriteTool'
import { NotebookEditTool } from './builtin/NotebookEditTool'
import { GlobTool } from './builtin/GlobTool'
import { GrepTool } from './builtin/GrepTool'
import { BashTool } from './builtin/BashTool'
import { PowerShellTool } from './builtin/PowerShellTool'
import { AskUserQuestionTool } from './builtin/AskUserQuestionTool'
import { PushNotificationTool } from './builtin/PushNotificationTool'
import { SubAgentRunnerTool } from './builtin/SubAgentRunnerTool'
import { TaskCreateTool } from './builtin/TaskCreateTool'
import { TaskGetTool } from './builtin/TaskGetTool'
import { TaskUpdateTool } from './builtin/TaskUpdateTool'
import { TaskListTool } from './builtin/TaskListTool'
import { DelegateTasksTool } from './builtin/DelegateTasksTool'
import { SkillTool } from './builtin/SkillTool'
import { RollbackLastEditTool } from './builtin/RollbackLastEditTool'
import { UpdateResumeStateTool } from './builtin/UpdateResumeStateTool'
import { WebSearchTool } from './builtin/WebSearchTool'
import { WebFetchTool } from './builtin/WebFetchTool'

import type { ToolDefinition } from '../../shared/types/provider'

export class ToolManager {
  private tools: Map<string, Tool> = new Map()

  private static READ_ONLY_TOOL_NAMES = new Set([
    'Read',
    'list_files',
    'Glob',
    'Grep'
  ])

  constructor() {
    this.registerBuiltinTools()
  }

  private registerBuiltinTools() {
    const builtinTools = [
      new ListFilesTool(),
      new ReadTool(),
      new EditTool(),
      new WriteTool(),
      new NotebookEditTool(),
      new GlobTool(),
      new GrepTool(),
      new BashTool(),
      new PowerShellTool(),
      new AskUserQuestionTool(),
      new PushNotificationTool(),
      new SkillTool(),
      new RollbackLastEditTool(),
      new UpdateResumeStateTool(),
      new WebSearchTool(),
      new WebFetchTool(),
      new SubAgentRunnerTool(),
      new TaskCreateTool(),
      new TaskGetTool(),
      new TaskUpdateTool(),
      new TaskListTool(),
      new DelegateTasksTool()
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

  /** 返回默认执行路径的 Tool Definitions 列表。 */
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

  /** 返回只读工具集合（用于只读子智能体） */
  getReadOnlyTools(): ToolDefinition[] {
    return this.getAllTools()
      .filter(t => ToolManager.READ_ONLY_TOOL_NAMES.has(t.name))
      .map(tool => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters_schema
        }
      }))
  }
}
