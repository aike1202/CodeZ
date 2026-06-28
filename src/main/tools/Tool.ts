import type { EditTransactionService } from '../services/EditTransactionService'

export interface ToolContext {
  workspaceRoot: string
  /** 当前会话 ID */
  sessionId?: string
  /** ResumeState 保存/加载 key */
  resumeStateKey?: string
  /** 当前活跃的修改事务 ID */
  transactionId?: string
  /** 修改事务管理服务实例 */
  editTransactionService?: EditTransactionService
}

export abstract class Tool {
  /** 工具的名称，应匹配 [a-zA-Z0-9_-]+ */
  abstract get name(): string
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
