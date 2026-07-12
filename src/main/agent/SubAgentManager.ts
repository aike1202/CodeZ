import { ChatService } from '../services/ChatService'
import { streamWithTimeoutRetry } from '../services/chat/retry'
import { ToolManager } from '../tools/ToolManager'
import * as path from 'path'
import type {
  ChatMessage,
  ModelContextCapabilities,
  ProviderTokenUsage,
  ThinkingConfig,
  ToolDefinition
} from '../../shared/types/provider'
import type { StreamCallbacks } from '../services/ChatService'
import type { AgentRunnerCallbacks } from './AgentRunner'
import type { SubAgentDetail } from '../../shared/types/subagent'
import { allSubAgentDefinitions } from './definitions'
import {
  generateSubmitResultTool,
  validateAgainstSpec,
  computeQualitySummary,
  formatSubmitResultValidationMessage
} from './AgentRunner/subagentOutputHelper'
import {
  isRecoverableProviderError,
  shouldRetryAfterUserMaintenance,
} from './AgentRunner/subagentRecoveryHelper'
import {
  contextScopeForSubAgent,
  type SessionRuntimeScopeSnapshot
} from '../../shared/types/context'
import type { ModelContextBuilder } from '../services/context/ModelContextBuilder'
import type { SessionRuntimeCoordinator, RuntimeTurnHandle } from '../services/context/SessionRuntimeCoordinator'
import { getContextCoreServices } from '../services/context/ContextRuntimeServices'
import { ModelContextBuilder as CanonicalModelContextBuilder } from '../services/context/ModelContextBuilder'
import { authorizePermissionToolCall } from '../services/PermissionManager'

// ─── 子 Agent 写权限范围（并行 Worker 用） ──────────────────

/**
 * 可写子 Agent 的非交互式权限范围。
 *
 * 只在需要写代码的 Worker 上传入；不传时保持现有行为（只读子 Agent 无 gap）。
 * spawn 在执行每个工具前先用此范围做边界校验，再交给统一运行时权限策略。
 * 越界直接拒绝；网络、敏感写入和 Hardline 等操作按主会话策略处理。
 */
export interface SubAgentPermissionScope {
  /**
   * 允许写入的文件路径列表（相对 workspaceRoot 或绝对路径）。
   * 仅当 allowAllWritesInWorkspace 为 false 时生效。
   */
  allowedWriteFiles?: string[]
  /** 是否允许 Worker 请求 Shell 工具；获准后仍需通过统一运行时权限策略。 */
  allowBash?: boolean
  /**
   * worktree 档：物理隔离已兜底，放宽到 workspaceRoot 内任意文件可写。
   * 为 true 时忽略 allowedWriteFiles，只做「不逃逸 workspaceRoot」的边界检查。
   */
  allowAllWritesInWorkspace?: boolean
}

// ─── SubAgent 定义接口 ──────────────────────────────────────

export interface SubAgentContext {
  workspaceRoot: string
  sessionId: string

  /** 要回答的核心问题 */
  task: string
  /** @deprecated 使用 task 代替 */
  parentPrompt: string

  /** SubAgent 调用标识 — 用于把事件路由到 SubAgentCard（由调用方 handleSubAgentRunnerSpawn 注入） */
  subAgentId?: string

  /** 续接此前被中断的 SubAgent；复用其规范化账本作用域与历史。 */
  resumeSubAgentId?: string

  /** 验收标准 — 子 Agent 必须逐条回答 */
  expectations?: {
    questions: string[]
    outOfScope?: string[]
  }

  /** 主 Agent 对问题域的已知信息（自然语言，非文件列表） */
  context?: string

  /** 领域边界（结构事实，非探索提示） */
  scope?: {
    directories?: string[]
    excludeGlobs?: string[]
  }

  /** 探索深度 → 框架映射到 maxLoops */
  depth?: 'quick' | 'normal' | 'exhaustive'

  parentMessages?: ChatMessage[]
  modelOverride?: string
  maxLoopsOverride?: number
  contextCapabilities?: ModelContextCapabilities
  runtimeCoordinator?: SessionRuntimeCoordinator
  contextBuilder?: ModelContextBuilder
  /** 父 Agent 的取消信号；触发时必须停止当前子智能体。 */
  parentSignal?: AbortSignal

  /**
   * 可写子 Agent 的写权限范围（非交互式校验）。
   * 只读子 Agent 不传，保持现有零权限门行为。
   */
  permissionScope?: SubAgentPermissionScope

  /** 主 Agent 的 API 配置（baseUrl / apiKey / model 等） */
  apiConfig: {
    baseUrl: string
    apiKey: string
    apiFormat: string
    model: string
    thinking?: ThinkingConfig
    contextWindowTokens?: number
    maxInputTokens?: number
    maxOutputTokens?: number
    reasoningCountsAgainstContext?: boolean
  }
}

export interface SubAgentResult {
  type: string
  status: 'completed' | 'failed' | 'interrupted'
  output: string
  structuredOutput?: SubAgentStructuredOutput
  qualitySummary?: SubAgentQualitySummary
  toolCallCount: number
  filesExamined?: string[]
  planSlug?: string
}

export interface SubAgentDefinition {
  type: string
  description: string

  /** 主 Agent 何时应委派给此子 Agent */
  whenToUse: string
  /** 主 Agent 何时不应委派 */
  whenNotToUse?: string
  /** 调用成本提示 */
  costHint?: string

  systemPromptBuilder: (ctx: SubAgentContext) => string | Promise<string>
  getTools(toolManager: ToolManager): ToolDefinition[]

  /** 输出规格 — 设置后框架自动注入 submit_result 工具 */
  outputSpec?: SubAgentOutputSpec

  maxLoops: number
  /** Number of final turns reserved for submit_result after exploration ends. */
  finalizationReserveLoops?: number
  /** Optional per-subagent depth budgets. Omitted entries use the shared defaults. */
  depthLoops?: Partial<Record<'quick' | 'normal' | 'exhaustive', number>>
  /** Reject a parsed structured result that does not meet agent-specific requirements. */
  validateStructuredOutput?: (output: SubAgentStructuredOutput) => string | undefined
  defaultModel?: string
  isolation?: 'none' | 'worktree'
  canRunInBackground?: boolean
  onBeforeSpawn?: (ctx: SubAgentContext) => Promise<void>
  onAfterComplete?: (ctx: SubAgentContext, result: SubAgentResult) => Promise<void>
}

export interface SubAgentHandle {
  id: string
  subAgentId: string
  sessionId: string
  type: string
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  result?: SubAgentResult
  cancel(): void
}

// ─── 结构化输出类型 ──────────────────────────────────────────

/** 结构化的子 Agent 元信息（最小字段，框架用于计算 qualitySummary） */
export interface SubAgentStructuredOutput {
  /** Markdown 格式的完整研究报告（主 Agent 直接阅读） */
  report: string
  /** 一句话结论 */
  conclusion: string
  /** 整体置信度 */
  confidence: 'high' | 'medium' | 'low'
  /** 实际读取过的文件路径 */
  filesExamined?: string[]
  /** 未能回答的问题数 */
  unresolvedCount?: number
}

/** 质量摘要 — 框架自动计算 */
export interface SubAgentQualitySummary {
  coverage: number
  confidence: string
  unresolvedCount: number
  filesExaminedCount: number
  warning: string | null
}

/** 子 Agent 输出字段定义 */
export interface SubAgentOutputField {
  name: string
  type: 'string' | 'string[]' | 'number' | 'boolean'
  description: string
  required: boolean
}

/** 子 Agent 输出规格 */
export interface SubAgentOutputSpec {
  description: string
  fields: SubAgentOutputField[]
}

// ─── 深度映射 ──────────────────────────────────────────────

const DEPTH_LOOPS: Record<string, number> = {
  quick: 6,
  normal: 12,
  exhaustive: 20,
}

/** 可写工具名集合 —— 需要 permissionScope 校验。 */
const WRITE_TOOL_NAMES = new Set(['Edit', 'Write', 'NotebookEdit'])
/** 终端命令工具名集合。 */
const SHELL_TOOL_NAMES = new Set(['Bash', 'PowerShell'])

/**
 * 对可写子 Agent 的单次工具调用做非交互式权限校验。
 *
 * @returns null 表示放行；否则返回拒绝原因字符串（回给子 Agent 当 error）。
 */
export function checkSubAgentToolPermission(
  toolName: string,
  parsedArgs: any,
  workspaceRoot: string,
  scope: SubAgentPermissionScope | undefined
): string | null {
  // 无 scope（只读子 Agent）：仅当调用了可写/终端工具才拒绝（它们本不该拿到这些工具）
  if (!scope) {
    if (WRITE_TOOL_NAMES.has(toolName) || SHELL_TOOL_NAMES.has(toolName)) {
      return `Tool '${toolName}' is not permitted for this subagent.`
    }
    return null
  }

  // 终端命令
  if (SHELL_TOOL_NAMES.has(toolName)) {
    if (!scope.allowBash) {
      return `Shell commands are not permitted for this worker.`
    }
    return null
  }

  // 文件写入
  if (WRITE_TOOL_NAMES.has(toolName)) {
    let targetPath: string | undefined =
      parsedArgs?.file_path || parsedArgs?.filePath || parsedArgs?.TargetFile || parsedArgs?.path
    if (!targetPath) {
      return `Write tool called without a file path.`
    }
    if (!path.isAbsolute(targetPath)) {
      targetPath = path.resolve(workspaceRoot, targetPath)
    }
    // 边界检查：不得逃逸 workspaceRoot
    const rel = path.relative(workspaceRoot, targetPath)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return `Write denied: path '${targetPath}' escapes the workspace.`
    }

    // worktree 档：workspace 内任意文件可写
    if (scope.allowAllWritesInWorkspace) {
      return null
    }

    // shared 档：必须命中 allowedWriteFiles
    const allowed = (scope.allowedWriteFiles || []).map(f =>
      path.isAbsolute(f) ? path.resolve(f) : path.resolve(workspaceRoot, f)
    )
    const resolvedTarget = path.resolve(targetPath)
    if (!allowed.some(a => a === resolvedTarget)) {
      return `Write denied: '${rel}' is outside your assigned file set. A sibling worker may be editing it — stop and report a blocker.`
    }
    return null
  }

  // 只读工具及其余（AskUserQuestion 等）放行
  return null
}

export async function authorizeSubAgentToolCall(
  toolName: string,
  parsedArgs: unknown,
  workspaceRoot: string,
  sessionId: string,
  scope: SubAgentPermissionScope | undefined,
  onPermissionRequest?: AgentRunnerCallbacks['onPermissionRequest'],
  agentId?: string
): Promise<string | null> {
  const scopeDenial = checkSubAgentToolPermission(toolName, parsedArgs, workspaceRoot, scope)
  if (scopeDenial) return scopeDenial

  const authorization = await authorizePermissionToolCall(
    toolName,
    parsedArgs,
    workspaceRoot,
    onPermissionRequest,
    null,
    sessionId,
    agentId
  )
  return authorization.allowed
    ? null
    : authorization.error || 'Tool execution denied by runtime permission policy.'
}

function resolveMaxLoops(def: SubAgentDefinition, ctx: SubAgentContext): number {
  if (ctx.maxLoopsOverride) return ctx.maxLoopsOverride
  if (ctx.depth) return def.depthLoops?.[ctx.depth] ?? DEPTH_LOOPS[ctx.depth] ?? def.maxLoops
  return def.maxLoops
}

function resolveFinalizationReserveLoops(def: SubAgentDefinition, maxLoops: number): number {
  if (!def.outputSpec || maxLoops < 2) return 0
  return Math.min(def.finalizationReserveLoops ?? 2, maxLoops - 1)
}

function buildRecoverableStopOutput(
  spec: SubAgentOutputSpec | undefined,
  error: string
): SubAgentStructuredOutput | undefined {
  if (!spec) return undefined

  const summary = `Executor stopped after recoverable API/network error: ${error}`
  const data: Record<string, unknown> = {}
  for (const field of spec.fields) {
    if (field.name === 'status') {
      data[field.name] = 'failed'
    } else if (field.name === 'summary') {
      data[field.name] = summary
    } else if (field.name === 'filesModified') {
      data[field.name] = []
    } else if (field.name === 'blockers') {
      data[field.name] = [error]
    } else if (field.required) {
      if (field.type === 'string') data[field.name] = summary
      if (field.type === 'string[]') data[field.name] = []
      if (field.type === 'number') data[field.name] = 0
      if (field.type === 'boolean') data[field.name] = false
    }
  }

  return validateAgainstSpec(data, spec)
}

function replayCompletedSubAgentResult(
  canonicalType: string,
  def: SubAgentDefinition,
  ctx: SubAgentContext,
  scope: SessionRuntimeScopeSnapshot
): SubAgentResult | undefined {
  const completedTurnId = scope.lastCompletedTurnId
  if (!completedTurnId) return undefined
  const messages = scope.activeMessages.filter((message) => message.turnId === completedTurnId)
  const assistantMessages = messages.filter((message) => message.role === 'assistant')
  const toolCalls = assistantMessages.flatMap((message) => message.toolCalls || [])
  const filesExamined = new Set<string>()

  for (const toolCall of toolCalls) {
    try {
      const args = JSON.parse(toolCall.arguments || '{}')
      if (toolCall.name === 'Read') {
        for (const file of args.files || []) {
          if (file?.file_path) filesExamined.add(file.file_path)
        }
      } else if (toolCall.name === 'list_files' && args.file_path) {
        filesExamined.add(args.file_path)
      }
    } catch {}
  }

  let structuredOutput: SubAgentStructuredOutput | undefined
  if (def.outputSpec) {
    for (const toolCall of [...toolCalls].reverse()) {
      if (toolCall.name !== 'submit_result') continue
      try {
        const candidate = validateAgainstSpec(JSON.parse(toolCall.arguments), def.outputSpec)
        if (candidate && !def.validateStructuredOutput?.(candidate)) {
          structuredOutput = candidate
          break
        }
      } catch {}
    }
    if (!structuredOutput) return undefined
  }

  const output = structuredOutput?.report || assistantMessages.at(-1)?.content || ''
  const result: SubAgentResult = {
    type: canonicalType,
    status: 'completed',
    output,
    structuredOutput,
    toolCallCount: toolCalls.filter((toolCall) => toolCall.name !== 'submit_result').length,
    filesExamined: Array.from(filesExamined)
  }
  if (structuredOutput) {
    result.qualitySummary = computeQualitySummary(
      ctx.expectations?.questions ?? [],
      structuredOutput
    )
  }
  return result
}

// ─── 系统提示扩展 ───────────────────────────────────────────

async function buildExtendedSystemPrompt(def: SubAgentDefinition, ctx: SubAgentContext): Promise<string> {
  const basePrompt = await def.systemPromptBuilder(ctx)
  const parts: string[] = [basePrompt]

  // 验收标准清单
  if (ctx.expectations?.questions?.length) {
    parts.push('\n\n## Acceptance Criteria')
    parts.push('Before submitting your results, you MUST verify each of the following:')
    parts.push(ctx.expectations.questions.map((q, i) => `  ${i + 1}. [ ] ${q}`).join('\n'))
    if (ctx.expectations.outOfScope?.length) {
      parts.push('\nThe following are OUT OF SCOPE — do not spend time on:')
      parts.push(ctx.expectations.outOfScope.map(s => `  - ${s}`).join('\n'))
    }
    parts.push('\nIf you cannot answer a question, state it explicitly in the "unresolved" list with a reason.')
  }

  // 主动发现触发器
  parts.push('\n\n## Proactive Discovery')
  parts.push('After your initial exploration (first 2-3 tool calls), review the questions.')
  parts.push('Ask yourself: "Is there a critical question the caller SHOULD have asked but didn\'t?"')
  parts.push('If yes, explore and answer it briefly. Include these findings in your report under an "Additional Discoveries" heading.')
  parts.push('(If it would take more than 3 extra rounds, note it in "unresolved" instead.)')

  // 输出指令（如果设置了 outputSpec）
  if (def.outputSpec) {
    parts.push('\n\n## Output Requirements')
    parts.push('When you have completed your work, call submit_result with your findings.')
    parts.push('Do NOT output your final answer as plain text — use the submit_result tool.')
    parts.push('If you produce plain text instead, your results may not be parsed correctly and important findings may be lost.')
  }

  return parts.join('\n')
}

// ─── SubAgentManager ────────────────────────────────────────

export class SubAgentManager {
  private static definitions = new Map<string, SubAgentDefinition>(
    allSubAgentDefinitions.map(def => [def.type, def])
  )
  private static aliases = new Map<string, string>([['Worker', 'Executor']])
  private static activeHandles = new Map<string, SubAgentHandle>()
  private static activeChangeListeners = new Set<(sessionId: string) => void>()
  /** 被禁用的子智能体 type —— 不在此集合中即为启用 */
  private static disabledTypes = new Set<string>()

  private static canonicalType(type: string): string {
    return this.aliases.get(type) || type
  }

  static register(definition: SubAgentDefinition): void {
    this.definitions.set(definition.type, definition)
  }

  static onActiveChange(listener: (sessionId: string) => void): () => void {
    this.activeChangeListeners.add(listener)
    return () => {
      this.activeChangeListeners.delete(listener)
    }
  }

  private static notifyActiveChange(sessionId: string): void {
    this.activeChangeListeners.forEach((listener) => listener(sessionId))
  }

  static getDefinition(type: string): SubAgentDefinition | undefined {
    return this.definitions.get(this.canonicalType(type))
  }

  static listDefinitions(): SubAgentDefinition[] {
    return Array.from(this.definitions.values())
  }

  /** 设置被禁用的子智能体 type 集合（由 SettingsService 驱动） */
  static setDisabledTypes(types: string[]): void {
    this.disabledTypes = new Set(types)
  }

  static isEnabled(type: string): boolean {
    const canonical = this.canonicalType(type)
    return !this.disabledTypes.has(canonical) && !this.disabledTypes.has(type)
  }

  /** 仅返回启用的子智能体定义 —— 用于向主 Agent 广告可用类型 */
  static listEnabledDefinitions(): SubAgentDefinition[] {
    return Array.from(this.definitions.values()).filter(def => this.isEnabled(def.type))
  }

  /**
   * 返回某个子智能体的完整详情，用于设置页「查看详情」弹窗。
   *
   * 系统提示词通过真实的 systemPromptBuilder + 框架扩展构建；
   * 运行时才注入的动态值（workspaceRoot、task、scope 等）以 {{...}} 占位标注，
   * 因此看到的提示词结构与实际运行时完全一致。
   */
  static async getDetail(type: string): Promise<SubAgentDetail | undefined> {
    const canonical = this.canonicalType(type)
    const def = this.definitions.get(canonical)
    if (!def) return undefined

    // 用占位上下文渲染提示词 —— 动态值显示为 {{...}} 便于阅读
    const previewCtx: SubAgentContext = {
      workspaceRoot: '{{workspaceRoot}}',
      sessionId: '{{sessionId}}',
      task: '{{task — 主 Agent 委派的核心问题}}',
      parentPrompt: '{{task — 主 Agent 委派的核心问题}}',
      expectations: {
        questions: ['{{expectations.questions — 主 Agent 指定的验收问题}}'],
      },
      scope: {
        directories: ['{{scope.directories}}'],
        excludeGlobs: ['{{scope.excludeGlobs}}'],
      },
      context: '{{context — 主 Agent 已知的背景信息}}',
      apiConfig: {
        baseUrl: '',
        apiKey: '',
        apiFormat: 'openai',
        model: '{{model}}',
      },
      contextCapabilities: { contextWindowTokens: 1 },
    }

    let systemPrompt: string
    try {
      systemPrompt = await buildExtendedSystemPrompt(def, previewCtx)
    } catch (e: any) {
      systemPrompt = `（提示词预览生成失败：${e?.message ?? e}）`
    }

    const toolManager = new ToolManager()
    let tools: string[] = []
    try {
      tools = def.getTools(toolManager).map(t => t.function.name)
    } catch {
      tools = []
    }
    if (def.outputSpec) {
      tools.push('submit_result')
    }

    return {
      type: def.type,
      description: def.description,
      whenToUse: def.whenToUse,
      whenNotToUse: def.whenNotToUse,
      costHint: def.costHint,
      enabled: this.isEnabled(def.type),
      maxLoops: def.maxLoops,
      defaultModel: def.defaultModel,
      isolation: def.isolation,
      canRunInBackground: def.canRunInBackground,
      tools,
      outputSpec: def.outputSpec
        ? {
            description: def.outputSpec.description,
            fields: def.outputSpec.fields.map(f => ({
              name: f.name,
              type: f.type,
              description: f.description,
              required: f.required,
            })),
          }
        : undefined,
      systemPrompt,
    }
  }

  /**
   * 启动一个 SubAgent。
   *
   * 创建独立的消息历史和 loop 计数，通过 callbacks 实时推送进度。
   * 返回 SubAgentResult（阻塞直到 SubAgent 结束）。
   */
  static async spawn(
    type: string,
    ctx: SubAgentContext,
    callbacks: AgentRunnerCallbacks
  ): Promise<SubAgentResult> {
    const canonical = this.canonicalType(type)
    const def = this.definitions.get(canonical)
    if (!def) {
      throw new Error(`SubAgent type '${type}' is not registered`)
    }
    if (!this.isEnabled(canonical)) {
      throw new Error(`SubAgent type '${type}' is disabled`)
    }

    const handleId = `subagent_${canonical}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    // SubAgent 事件作用域标识 — 优先用调用方注入的（与父工具调用绑定），否则回退到 handleId
    const subAgentId = ctx.subAgentId || handleId
    let abortController = new AbortController()

    const handle: SubAgentHandle = {
      id: handleId,
      subAgentId,
      sessionId: ctx.sessionId,
      type: canonical,
      status: 'running',
      cancel: () => {
        abortController.abort()
        handle.status = 'interrupted'
      }
    }
    const abortFromParent = () => handle.cancel()

    this.activeHandles.set(handleId, handle)
    this.notifyActiveChange(ctx.sessionId)
    ctx.parentSignal?.addEventListener('abort', abortFromParent, { once: true })
    if (ctx.parentSignal?.aborted) handle.cancel()

    const setup = await (async () => {
      const core = ctx.runtimeCoordinator
        ? { coordinator: ctx.runtimeCoordinator, ledger: ctx.runtimeCoordinator.ledger }
        : getContextCoreServices()
      const contextScopeId = contextScopeForSubAgent(ctx.resumeSubAgentId || subAgentId)
      if (ctx.resumeSubAgentId) {
        const previousScope = await core.coordinator.getScopeView(ctx.sessionId, contextScopeId)
        const latestTurnId = previousScope?.activeMessages.at(-1)?.turnId
        if (!previousScope || previousScope.activeMessages.length === 0) {
          throw new Error(`Cannot resume SubAgent '${ctx.resumeSubAgentId}': context was not found.`)
        }
        if (latestTurnId && previousScope.lastCompletedTurnId === latestTurnId) {
          const replayedResult = replayCompletedSubAgentResult(canonical, def, ctx, previousScope)
          if (!replayedResult) {
            throw new Error(`Cannot replay completed SubAgent '${ctx.resumeSubAgentId}': durable result was invalid.`)
          }
          return { replayedResult }
        }
        if (!latestTurnId || previousScope.lastInterruptedTurnId !== latestTurnId) {
          throw new Error(`Cannot resume SubAgent '${ctx.resumeSubAgentId}': its latest run was not interrupted.`)
        }
      }

      if (def.onBeforeSpawn) await def.onBeforeSpawn(ctx)

      const toolManager = new ToolManager()
      const availableTools = def.getTools(toolManager)
      let submitResultTool: ToolDefinition | undefined
      if (def.outputSpec) {
        submitResultTool = generateSubmitResultTool(def.outputSpec)
        availableTools.push(submitResultTool)
      }

      const systemPrompt = await buildExtendedSystemPrompt(def, ctx)
      const task = ctx.task || ctx.parentPrompt || ''
      const contextBuilder = ctx.contextBuilder || new CanonicalModelContextBuilder(core.ledger)
      if (!ctx.contextCapabilities) {
        throw new Error('SubAgent requires resolved model context capabilities')
      }
      const contextCapabilities: ModelContextCapabilities = ctx.contextCapabilities
      const turnInput = ctx.resumeSubAgentId
        ? [
            'Continue the interrupted task from the existing SubAgent history.',
            'Do not restart, re-plan, or repeat completed inspection and tool work.',
            'Resume from the last durable state and finish the original task.'
          ].join(' ')
        : task
      const runtimeTurn = await core.coordinator.beginTurn({
        sessionId: ctx.sessionId,
        contextScopeId,
        text: turnInput,
        model: ctx.modelOverride || ctx.apiConfig.model
      })
      return {
        toolManager,
        availableTools,
        submitResultTool,
        systemPrompt,
        core,
        contextBuilder,
        contextCapabilities,
        contextScopeId,
        runtimeTurn
      }
    })().catch((error) => {
      ctx.parentSignal?.removeEventListener('abort', abortFromParent)
      if (this.activeHandles.delete(handleId)) this.notifyActiveChange(ctx.sessionId)
      handle.status = abortController.signal.aborted ? 'interrupted' : 'failed'
      throw error
    })
    if ('replayedResult' in setup && setup.replayedResult) {
      handle.status = 'completed'
      handle.result = setup.replayedResult
      ctx.parentSignal?.removeEventListener('abort', abortFromParent)
      if (this.activeHandles.delete(handleId)) this.notifyActiveChange(ctx.sessionId)
      return setup.replayedResult
    }
    const {
      toolManager,
      availableTools,
      submitResultTool,
      systemPrompt,
      core,
      contextBuilder,
      contextCapabilities,
      contextScopeId,
      runtimeTurn
    } = setup
    let runtimeClosed = false

    const chatService = new ChatService()
    let loopCount = 0
    let toolCallCount = 0
    let finalOutput = ''
    let forcedStructuredOutput: SubAgentStructuredOutput | undefined
    let failureReason: string | undefined
    const filesExamined = new Set<string>()
    const effectiveMaxLoops = resolveMaxLoops(def, ctx)
    const finalizationReserveLoops = resolveFinalizationReserveLoops(def, effectiveMaxLoops)
    let finalizationNoticeRecorded = false

    try {
      while (loopCount < effectiveMaxLoops && !abortController.signal.aborted) {
        loopCount++
        const isFinalizationPhase = Boolean(
          submitResultTool && finalizationReserveLoops > 0 &&
          loopCount > effectiveMaxLoops - finalizationReserveLoops
        )
        const activeTools = isFinalizationPhase && submitResultTool
          ? [submitResultTool]
          : availableTools

        if (isFinalizationPhase && !finalizationNoticeRecorded) {
          await core.coordinator.recordUserContinuation(
            runtimeTurn,
            'Exploration budget is exhausted. Do not perform more research or return plain text. Synthesize the evidence already collected and call submit_result with the required Markdown handoff now.'
          )
          finalizationNoticeRecorded = true
        }

        const builtContext = await contextBuilder.build({
          sessionId: ctx.sessionId,
          contextScopeId,
          currentInputMessageId: runtimeTurn.userMessageId,
          currentInput: runtimeTurn.inputText,
          capabilities: contextCapabilities,
          systemPrompt,
          toolSchemas: activeTools
        })

        let currentContent = ''
        let toolCallsAcc: Record<number, { id: string; type: 'function'; function: { name: string; arguments: string }; thought_signature?: string }> = {}
        let gotError = false
        let lastError = ''
        let thoughtSig: string | undefined
        let currentUsage: ProviderTokenUsage | undefined

        await new Promise<void>((resolve) => {
          streamWithTimeoutRetry(
            (attemptCallbacks, signal) =>
              chatService.streamChat(
                {
                  baseUrl: ctx.apiConfig.baseUrl,
                  apiKey: ctx.apiConfig.apiKey,
                  apiFormat: ctx.apiConfig.apiFormat,
                  model: ctx.modelOverride || ctx.apiConfig.model,
                  messages: builtContext.messages,
                  tools: activeTools,
                  thinking: ctx.apiConfig.thinking
                },
                attemptCallbacks,
                signal
              ),
            {
              onChunk: (delta, reasoningDelta, toolCallsChunk, thoughtSignature) => {
                if (abortController.signal.aborted) return
                if (thoughtSignature) thoughtSig = thoughtSignature
                if (delta) {
                  currentContent += delta
                  callbacks.onSubAgentChunk?.(subAgentId, delta, '')
                }
                if (reasoningDelta) {
                  callbacks.onSubAgentChunk?.(subAgentId, '', reasoningDelta)
                }
                if (toolCallsChunk) {
                  for (const tc of toolCallsChunk) {
                    const idx = tc.index
                    if (!toolCallsAcc[idx]) {
                      toolCallsAcc[idx] = { id: tc.id || '', type: 'function', function: { name: tc.function?.name || '', arguments: '' } }
                    }
                    const acc = toolCallsAcc[idx]
                    if (tc.id) acc.id = tc.id
                    if (tc.function?.name) acc.function.name = tc.function.name
                    if (tc.function?.arguments) acc.function.arguments += tc.function.arguments
                    if (tc.thought_signature) acc.thought_signature = tc.thought_signature
                    else if (thoughtSignature) acc.thought_signature = thoughtSignature
                  }
                }
              },
              onDone: () => resolve(),
              onUsage: (usage) => { currentUsage = usage },
              onError: (err) => {
                gotError = true
                lastError = err
                resolve()
              }
            },
            abortController.signal,
            {
              onRetry: (attempt) => {
                callbacks.onSubAgentChunk?.(
                  subAgentId,
                  `\n\n[SubAgent 网络/API 暂无响应，正在自动重试 ${attempt + 1}...]\n\n`,
                  ''
                )
              },
            }
          )
        })

        if (gotError || abortController.signal.aborted) {
          if (gotError && !abortController.signal.aborted && !isRecoverableProviderError(lastError)) {
            failureReason = lastError || 'SubAgent provider request failed.'
            finalOutput = failureReason
          }
          if (gotError && !abortController.signal.aborted && isRecoverableProviderError(lastError)) {
            callbacks.onSubAgentChunk?.(
              subAgentId,
              `\n\n[SubAgent 遇到可恢复的 API/网络问题，等待维护后继续：${lastError}]\n\n`,
              ''
            )
            if (callbacks.onAskUserRequest) {
              const answers = await callbacks.onAskUserRequest({
                id: `subagent_recover_${subAgentId}_${Date.now()}`,
                questions: [
                  {
                    header: '执行器恢复',
                    question: [
                      'Executor 遇到 API/网络问题，当前步骤已暂停。',
                      '',
                      `错误：${lastError}`,
                      '',
                      '请维护网络、Provider、API Key、额度或模型配置后再继续。继续后会复用当前 Executor 上下文重试，不会重新开始。'
                    ].join('\n'),
                    options: [
                      {
                        label: '已修复，继续重试',
                        description: '继续当前 Executor，不丢弃已积累的上下文。'
                      },
                      {
                        label: '停止这个 Executor',
                        description: '停止该 Executor，让主 Agent 接手或稍后重新分派。'
                      }
                    ],
                    multiSelect: false,
                    submitLabel: '继续',
                    ignoreLabel: '停止'
                  }
                ]
              })
              if (shouldRetryAfterUserMaintenance(answers)) {
                loopCount = Math.max(0, loopCount - 1)
                continue
              }
            }
            forcedStructuredOutput = buildRecoverableStopOutput(def.outputSpec, lastError)
            failureReason = lastError
            finalOutput =
              forcedStructuredOutput?.conclusion ||
              `Executor stopped after recoverable API/network error: ${lastError}`
          }
          break
        }

        const toolCallsArray = Object.keys(toolCallsAcc).map((k) => {
          const tc = (toolCallsAcc as any)[k]
          const sig = tc.thought_signature || thoughtSig
          return {
            id: tc.id,
            type: tc.type,
            function: { ...tc.function, thought_signature: sig || 'skip_thought_signature_validator' },
            thought_signature: sig || 'skip_thought_signature_validator'
          }
        })

        await core.coordinator.recordAssistant(runtimeTurn, {
          content: currentContent || '',
          toolCalls: toolCallsArray.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
            thoughtSignature: toolCall.thought_signature
          })),
          usage: currentUsage
        })
        for (const toolCall of toolCallsArray) {
          callbacks.onSubAgentToolStart?.(
            subAgentId,
            toolCall.id,
            toolCall.function.name,
            toolCall.function.arguments,
            toolCall.thought_signature
          )
        }

        if (toolCallsArray.length > 0) {
          // 检查是否有 submit_result 调用
          const submitCall = toolCallsArray.find(tc => tc.function.name === 'submit_result')
          if (submitCall && def.outputSpec) {
            const closeSiblingCalls = async (reason: string) => {
              for (const sibling of toolCallsArray) {
                if (sibling.id === submitCall.id) continue
                const interrupted = JSON.stringify({
                  ok: false,
                  error: { code: 'EXECUTION_INTERRUPTED', message: reason }
                })
                await core.coordinator.recordToolResult(runtimeTurn, {
                  callId: sibling.id,
                  name: sibling.function.name,
                  content: interrupted,
                  status: 'interrupted'
                })
                callbacks.onSubAgentToolEnd?.(subAgentId, sibling.id, interrupted)
              }
            }

            // 处理 submit_result
            let structuredOutput: SubAgentStructuredOutput | undefined
            let submitValidationMessage: string | undefined
            try {
              const args = JSON.parse(submitCall.function.arguments)
              structuredOutput = validateAgainstSpec(args, def.outputSpec)
              if (structuredOutput) {
                submitValidationMessage = def.validateStructuredOutput?.(structuredOutput)
                if (submitValidationMessage) {
                  structuredOutput = undefined
                }
              }
            } catch {
              // 解析失败，继续循环让模型重试
            }

            if (structuredOutput) {
              const ack = JSON.stringify({ ok: true, data: 'Results submitted and validated.' })
              await core.coordinator.recordToolResult(runtimeTurn, {
                callId: submitCall.id,
                name: 'submit_result',
                content: ack,
                status: 'success'
              })
              callbacks.onSubAgentToolEnd?.(subAgentId, submitCall.id, ack)
              await closeSiblingCalls('submit_result completed this subagent run')

              finalOutput = currentContent

              const subResult: SubAgentResult = {
                type: canonical,
                status: 'completed',
                output: structuredOutput.report,
                structuredOutput,
                toolCallCount,
                filesExamined: Array.from(filesExamined),
              }

              // 计算质量摘要
              subResult.qualitySummary = computeQualitySummary(
                ctx.expectations?.questions ?? [],
                structuredOutput
              )

              handle.status = 'completed'
              handle.result = subResult

              // 生命周期钩子：完成后
              if (def.onAfterComplete) {
                await def.onAfterComplete(ctx, subResult)
              }

              await core.coordinator.completeTurn(runtimeTurn, { stopReason: 'tool_calls', usage: currentUsage })
              runtimeClosed = true

              return subResult
            } else {
              // submit_result 验证失败 — 推送错误让模型重试
              const validationError = JSON.stringify({
                ok: false,
                error: {
                  code: 'VALIDATION_ERROR',
                  message: submitValidationMessage || formatSubmitResultValidationMessage(def.outputSpec)
                }
              })
              await core.coordinator.recordToolResult(runtimeTurn, {
                callId: submitCall.id,
                name: 'submit_result',
                content: validationError,
                status: 'error'
              })
              callbacks.onSubAgentToolEnd?.(subAgentId, submitCall.id, validationError)
              await closeSiblingCalls('submit_result validation failed; other calls were skipped')
              continue  // 不执行其他工具，让模型重新提交
            }
          }

          // 执行常规工具调用
          const toolResults = await Promise.all(
            toolCallsArray.map(async (tc) => {
              const name = tc.function.name
              const args = tc.function.arguments
              toolCallCount++

              const toolInstance = toolManager.getTool(name)
              let result = ''
              if (!toolInstance) {
                result = JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: `Tool '${name}' not found` } })
              } else {
                // 先校验子代理 scope，再进入与主 Agent 相同的运行时权限策略。
                let parsedArgs: any = {}
                try { parsedArgs = JSON.parse(args) } catch {}
                const denyReason = await authorizeSubAgentToolCall(
                  name,
                  parsedArgs,
                  ctx.workspaceRoot,
                  ctx.sessionId,
                  ctx.permissionScope,
                  callbacks.onPermissionRequest,
                  subAgentId
                )
                if (denyReason) {
                  result = JSON.stringify({ ok: false, error: { code: 'PERMISSION_DENIED', message: denyReason } })
                  await core.coordinator.recordToolResult(runtimeTurn, {
                    callId: tc.id, name, content: result, status: 'error'
                  })
                  callbacks.onSubAgentToolEnd?.(subAgentId, tc.id, result)
                  return { role: 'tool' as const, tool_call_id: tc.id, name, content: result }
                }
                try {
                  const raw = await toolInstance.execute(args, {
                    workspaceRoot: ctx.workspaceRoot,
                    sessionId: ctx.sessionId,
                    contextScopeId,
                    runtimeCoordinator: core.coordinator,
                    runtimeTurn,
                    abortSignal: abortController.signal
                  })
                  result = JSON.stringify({ ok: true, data: raw })

                  // 追踪读取的文件
                  if (name === 'Read') {
                    try {
                      const parsed = JSON.parse(args)
                      for (const file of parsed.files || []) {
                        if (file?.file_path) filesExamined.add(file.file_path)
                      }
                    } catch {}
                  } else if (name === 'list_files') {
                    try { const parsed = JSON.parse(args); if (parsed.file_path) filesExamined.add(parsed.file_path) } catch {}
                  }
                } catch (err: any) {
                  result = JSON.stringify({ ok: false, error: { code: 'EXECUTION_ERROR', message: err.message } })
                }
              }

              let resultStatus: 'success' | 'error' = 'error'
              try { resultStatus = JSON.parse(result).ok === true ? 'success' : 'error' } catch {}
              await core.coordinator.recordToolResult(runtimeTurn, {
                callId: tc.id, name, content: result, status: resultStatus
              })
              callbacks.onSubAgentToolEnd?.(subAgentId, tc.id, result)
              return { role: 'tool' as const, tool_call_id: tc.id, name, content: result }
            })
          )

        } else {
          // SubAgent 产出最终文本（未调用 submit_result 的纯文本回退）
          finalOutput = currentContent

          if (def.outputSpec && loopCount < effectiveMaxLoops) {
            await core.coordinator.recordUserContinuation(
              runtimeTurn,
              isFinalizationPhase
                ? 'A plain-text response is not a valid result. Call submit_result now with every required field.'
                : 'Do not stop with a plain-text status update. Continue investigating with the available tools, or call submit_result only after the required Markdown handoff is complete.'
            )
            continue
          }

          await core.coordinator.completeTurn(runtimeTurn, { stopReason: 'stop', usage: currentUsage })
          runtimeClosed = true
          if (def.outputSpec) {
            failureReason = 'SubAgent exhausted its run without submitting a valid structured result.'
          }
          break
        }
      }

      if (abortController.signal.aborted) {
        const interruptedResult: SubAgentResult = {
          type: canonical,
          status: 'interrupted',
          output: 'SubAgent execution was interrupted before completion.',
          toolCallCount,
          filesExamined: Array.from(filesExamined)
        }
        handle.status = 'interrupted'
        handle.result = interruptedResult
        return interruptedResult
      }

      const protocolFailure = Boolean(def.outputSpec && !forcedStructuredOutput)
      if (protocolFailure && !failureReason) {
        failureReason = 'SubAgent exhausted its run without submitting a valid structured result.'
      }
      if (protocolFailure && failureReason) {
        finalOutput = failureReason
      } else if (failureReason && !finalOutput) {
        finalOutput = failureReason
      }
      const subResult: SubAgentResult = {
        type: canonical,
        status: failureReason ? 'failed' : 'completed',
        output: finalOutput,
        structuredOutput: forcedStructuredOutput,
        toolCallCount,
        filesExamined: Array.from(filesExamined),
      }

      // 如果设置了 outputSpec 但没有 structuredOutput，生成警告质量摘要
      if (def.outputSpec && !subResult.structuredOutput) {
        subResult.qualitySummary = {
          coverage: 0,
          confidence: 'low',
          unresolvedCount: 0,
          filesExaminedCount: 0,
          warning: failureReason || 'SubAgent produced plain text instead of structured output via submit_result. Findings may be incomplete.',
        }
      }

      handle.status = subResult.status
      handle.result = subResult

      // 生命周期钩子：完成后
      if (def.onAfterComplete) {
        await def.onAfterComplete(ctx, subResult)
      }

      return subResult
    } catch (err: any) {
      if (abortController.signal.aborted) {
        const interruptedResult: SubAgentResult = {
          type: canonical,
          status: 'interrupted',
          output: 'SubAgent execution was interrupted before completion.',
          toolCallCount,
          filesExamined: Array.from(filesExamined)
        }
        handle.status = 'interrupted'
        handle.result = interruptedResult
        return interruptedResult
      }
      handle.status = 'failed'
      throw err
    } finally {
      ctx.parentSignal?.removeEventListener('abort', abortFromParent)
      if (!runtimeClosed) {
        await core.coordinator.interruptTurn(
          runtimeTurn,
          abortController.signal.aborted ? 'Subagent was cancelled' : 'Subagent ended before a completed protocol turn'
        ).catch(() => undefined)
        runtimeClosed = true
      }
      if (this.activeHandles.delete(handleId)) this.notifyActiveChange(ctx.sessionId)
    }
  }

  static getHandle(id: string): SubAgentHandle | undefined {
    return this.activeHandles.get(id)
  }

  static listActive(): SubAgentHandle[] {
    return Array.from(this.activeHandles.values())
  }

  static listActiveForSession(sessionId: string): string[] {
    return Array.from(this.activeHandles.values())
      .filter((handle) => handle.sessionId === sessionId && handle.status === 'running')
      .map((handle) => handle.subAgentId)
  }
}
