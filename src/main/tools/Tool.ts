import type { EditTransactionService } from '../services/EditTransactionService'
import type { ContextScopeId, FileContextReference } from '../../shared/types/context'

export interface ToolContext {
  workspaceRoot: string
  /** 当前会话 ID */
  sessionId?: string
  /** 当前 Agent 的独立上下文作用域。 */
  contextScopeId?: ContextScopeId
  runtimeCoordinator?: import('../services/context/SessionRuntimeCoordinator').SessionRuntimeCoordinator
  runtimeTurn?: import('../services/context/SessionRuntimeCoordinator').RuntimeTurnHandle
  /** 当前活跃的修改事务 ID */
  transactionId?: string
  /** 修改事务管理服务实例 */
  editTransactionService?: EditTransactionService
  /** 取消当前 Agent/子智能体时终止仍在运行的工具。 */
  abortSignal?: AbortSignal
}

export interface ToolExecutionOutput {
  /** Content persisted in the model ledger and sent to the provider. */
  content: string
  /** Optional richer payload for the renderer; never enters model context. */
  uiContent?: string
  fileReferences?: FileContextReference[]
}

export function throwIfToolAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const reason = signal.reason
  if (reason instanceof Error) throw reason
  throw new Error(
    typeof reason === 'string' && reason.trim()
      ? reason
      : 'Tool execution was aborted before the mutation could run.'
  )
}

export async function discardStagedBackup(
  context: ToolContext,
  absolutePath: string,
  staged: boolean
): Promise<void> {
  if (!staged || !context.editTransactionService || !context.transactionId) return
  const discard = (context.editTransactionService as any).discardBackup
  if (typeof discard !== 'function') return
  await discard.call(context.editTransactionService, context.transactionId, absolutePath)
}

export async function recordTransactionMutation(
  context: ToolContext,
  absolutePath: string,
  sha256: string | null
): Promise<void> {
  if (!context.editTransactionService || !context.transactionId) return
  const record = (context.editTransactionService as any).recordMutationResult
  if (typeof record !== 'function') return
  await record.call(context.editTransactionService, context.transactionId, absolutePath, sha256)
}

/** Serializes every mutation that belongs to the same edit transaction. */
export async function runWithTransactionLock<T>(
  context: ToolContext,
  operation: () => Promise<T>
): Promise<T> {
  const guardedOperation = () => {
    throwIfToolAborted(context.abortSignal)
    return operation()
  }
  if (!context.editTransactionService || !context.transactionId) return guardedOperation()
  const runExclusive = (context.editTransactionService as any).runExclusive
  if (typeof runExclusive !== 'function') return guardedOperation()
  return runExclusive.call(
    context.editTransactionService,
    context.transactionId,
    guardedOperation,
    context.abortSignal
  )
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

  /**
   * Executes a tool while preserving client-only metadata that must not be sent
   * inside the model-visible tool result. Tools without metadata use this default.
   */
  async executeWithMetadata(args: string, context: ToolContext): Promise<ToolExecutionOutput> {
    return { content: await this.execute(args, context) }
  }
}
