import type { EditTransactionService } from '../services/EditTransactionService'

export interface ToolContext {
  workspaceRoot: string
  /** 当前会话 ID */
  sessionId?: string
  runtimeCoordinator?: import('../services/context/SessionRuntimeCoordinator').SessionRuntimeCoordinator
  runtimeTurn?: import('../services/context/SessionRuntimeCoordinator').RuntimeTurnHandle
  /** 当前活跃的修改事务 ID */
  transactionId?: string
  /** 修改事务管理服务实例 */
  editTransactionService?: EditTransactionService
  /** 取消当前 Agent/子智能体时终止仍在运行的工具。 */
  abortSignal?: AbortSignal
}

export abstract class Tool {
  /** 工具的名称，应匹配 [a-zA-Z0-9_-]+ */
  abstract get name(): string
  /** 一句话摘要，用于 AvailableTools 精简列表（~10 words max） */
  abstract get summary(): string
  /** 描述它的作用被大模型看到 */
  abstract get description(): string
  /** 工具接受的参数类型，JSON Schema 格式 */
  abstract get parameters_schema(): Record<string, any>

  /**
   * 工具的执行体
   * @param args 大模型传入的解析后的 JSON 参数
   * @param context 执行上下文
   * @returns 被转为 string 的响应体给模型
   */
  abstract execute(args: string, context: ToolContext): Promise<string>
}
