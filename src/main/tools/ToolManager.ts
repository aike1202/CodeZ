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
import { ExecutionInspectTool } from './builtin/ExecutionInspectTool'
import { ExecutionControlTool } from './builtin/ExecutionControlTool'
import { ToolSearchTool } from './builtin/ToolSearchTool'
import { ToolResultReadTool } from './builtin/ToolResultReadTool'
import { ListMcpResourcesTool } from './builtin/ListMcpResourcesTool'
import { ReadMcpResourceTool } from './builtin/ReadMcpResourceTool'
import { GetMcpPromptTool } from './builtin/GetMcpPromptTool'
import { McpAuthTool } from './builtin/McpAuthTool'

import type { ToolDefinition } from '../../shared/types/provider'
import { ToolRegistry } from './runtime/ToolRegistry'
import { ToolExposurePlanner } from './runtime/ToolExposurePlanner'
import type {
  AgentRole,
  ToolCatalogSnapshot,
  ToolExposurePlan,
  ToolHandler
} from './runtime/types'

export class ToolManager {
  private static readonly sharedRegistry = new ToolRegistry()
  private static builtinsRegistered = false
  private readonly registry = ToolManager.sharedRegistry
  private readonly exposurePlanner = new ToolExposurePlanner()

  private static READ_ONLY_TOOL_NAMES = new Set([
    'Read',
    'list_files',
    'Glob',
    'Grep'
  ])

  constructor() {
    if (!ToolManager.builtinsRegistered) {
      this.registerBuiltinTools()
      ToolManager.builtinsRegistered = true
    }
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
      new ToolSearchTool(),
      new ToolResultReadTool(),
      new ListMcpResourcesTool(),
      new ReadMcpResourceTool(),
      new GetMcpPromptTool(),
      new McpAuthTool(),
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
      new DelegateTasksTool(),
      new ExecutionInspectTool(),
      new ExecutionControlTool()
    ]
    
    for (const tool of builtinTools) {
      this.registry.registerLegacy(tool)
    }
  }

  getTool(name: string): Tool | undefined {
    return this.registry.resolve(name)?.legacyTool
  }

  getAllTools(): Tool[] {
    return this.registry.getAllHandlers()
      .map((handler) => handler.legacyTool)
      .filter((tool): tool is Tool => Boolean(tool))
  }

  getRegistry(): ToolRegistry {
    return this.registry
  }

  registerHandler(handler: ToolHandler): void {
    this.registry.register(handler)
  }

  unregisterSource(sourceId: string): void {
    this.registry.unregisterSource(sourceId)
  }

  createCatalogSnapshot(
    agentRole: AgentRole = 'main',
    workspaceRoot?: string
  ): ToolCatalogSnapshot {
    return this.registry.createSnapshot({
      platform: process.platform,
      agentRole,
      workspaceRoot
    })
  }

  createExposurePlan(input: {
    catalog?: ToolCatalogSnapshot
    agentRole?: AgentRole
    workspaceRoot?: string
    deniedTools?: ReadonlySet<string>
    activatedDeferredTools?: ReadonlySet<string>
    maxTools?: number
    schemaTokenBudget?: number
  } = {}): ToolExposurePlan {
    const agentRole = input.agentRole || 'main'
    return this.exposurePlanner.plan({
      catalog: input.catalog || this.createCatalogSnapshot(agentRole, input.workspaceRoot),
      agentRole,
      deniedTools: input.deniedTools,
      activatedDeferredTools: input.activatedDeferredTools,
      maxTools: input.maxTools,
      schemaTokenBudget: input.schemaTokenBudget
    })
  }

  getToolDefinitionsForExposure(plan: ToolExposurePlan): ToolDefinition[] {
    return this.exposurePlanner.toToolDefinitions(plan)
  }

  /** 返回默认执行路径的 Tool Definitions 列表。 */
  getToolDefinitions(): ToolDefinition[] {
    return this.createCatalogSnapshot().descriptors.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
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
