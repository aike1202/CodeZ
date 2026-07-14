import { SubAgentManager } from '../SubAgentManager'
import { BrowserWindow } from 'electron'
import { createHash } from 'crypto'
import { IPC_CHANNELS } from '../../../shared/ipc/channels'
import type { AgentRunConfig, AgentRunnerCallbacks } from './types'
import type { SubAgentHandoff } from '../../../shared/types/subagent'
import { contextScopeForSubAgent } from '../../../shared/types/context'

function truncateBridgeText(value: string, maxLength: number): string {
  const normalized = value.trim()
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength)}\n...[truncated]`
}

async function validateReviewerClosureReference(
  parsed: {
    review_mode?: 'initial' | 'closure'
    review_cycle_id?: string
    previous_finding_ids?: string[]
    resume_subagent_id?: string
  },
  config: AgentRunConfig
): Promise<string | null> {
  if (
    parsed.review_mode !== 'closure' ||
    !parsed.resume_subagent_id ||
    !config.runtimeCoordinator ||
    !config.sessionId
  ) {
    return null
  }

  const scope = await config.runtimeCoordinator.getScopeView(
    config.sessionId,
    contextScopeForSubAgent(parsed.resume_subagent_id)
  )
  if (!scope) return 'Reviewer closure could not find the referenced durable Reviewer context.'

  const submitCalls = scope.activeMessages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.toolCalls || [])
    .filter((call) => call.name === 'submit_result')
  const previous = [...submitCalls].reverse().map((call) => {
    try {
      return JSON.parse(call.arguments || '{}') as Record<string, unknown>
    } catch {
      return null
    }
  }).find((value) => value !== null)

  if (!previous) return 'Reviewer closure could not recover the initial structured verdict.'
  if (previous.reviewMode !== 'initial') {
    return 'Reviewer closure must continue an initial review, not another closure.'
  }
  if (previous.reviewCycleId !== parsed.review_cycle_id) {
    return 'Reviewer closure review_cycle_id does not match the initial review.'
  }
  if (previous.verdict !== 'BLOCKED') {
    return 'Reviewer closure is only valid after an initial BLOCKED verdict.'
  }

  const priorIds = Array.isArray(previous.blockingFindings)
    ? previous.blockingFindings
        .map((finding) => finding && typeof finding === 'object'
          ? String((finding as Record<string, unknown>).id || '')
          : '')
        .filter(Boolean)
        .sort()
    : []
  const suppliedIds = [...(parsed.previous_finding_ids || [])].sort()
  if (
    priorIds.length === 0 ||
    priorIds.length !== suppliedIds.length ||
    priorIds.some((id, index) => id !== suppliedIds[index])
  ) {
    return 'Reviewer closure previous_finding_ids must exactly match the initial blocking findings.'
  }
  return null
}

function unwrapSubAgentResult(content: string): Record<string, unknown> | null {
  let value: unknown = content
  for (let depth = 0; depth < 4; depth++) {
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
      } catch {
        return null
      }
      continue
    }
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    if (typeof record.status === 'string' && typeof record.subagent_type === 'string') {
      return record
    }
    if (record.data !== undefined) {
      value = record.data
      continue
    }
    return null
  }
  return null
}

async function validateReviewerInitialCycle(
  parsed: {
    review_mode?: 'initial' | 'closure'
    review_cycle_id?: string
  },
  config: AgentRunConfig,
  currentToolCallId: string
): Promise<string | null> {
  if (
    parsed.review_mode !== 'initial' ||
    !parsed.review_cycle_id ||
    !config.runtimeCoordinator ||
    !config.runtimeTurn ||
    !config.sessionId
  ) {
    return null
  }

  const scope = await config.runtimeCoordinator.getScopeView(
    config.sessionId,
    config.runtimeTurn.contextScopeId
  )
  if (!scope) return null
  const matchingCallIds = new Set<string>()
  for (const message of scope.activeMessages) {
    if (message.role !== 'assistant') continue
    for (const call of message.toolCalls || []) {
      if (call.name !== 'SubAgentRunner' || call.id === currentToolCallId) continue
      try {
        const args = JSON.parse(call.arguments || '{}')
        if (
          args.subagent_type === 'Reviewer' &&
          args.review_mode === 'initial' &&
          args.review_cycle_id === parsed.review_cycle_id
        ) {
          matchingCallIds.add(call.id)
        }
      } catch {}
    }
  }
  if (matchingCallIds.size === 0) return null

  const hasCompletedCycle = scope.activeMessages.some((message) => {
    if (
      message.role !== 'tool' ||
      message.name !== 'SubAgentRunner' ||
      !message.toolCallId ||
      !matchingCallIds.has(message.toolCallId)
    ) {
      return false
    }
    const result = unwrapSubAgentResult(message.content || '')
    return result?.status === 'completed'
  })
  return hasCompletedCycle
    ? `Reviewer cycle '${parsed.review_cycle_id}' already has a completed initial review. Resume that Reviewer for closure instead of starting a fresh Reviewer.`
    : null
}

/**
 * 通用子智能体 spawn 拦截处理。
 *
 * 与 planRunnerHelper 的区别：
 * - 无批准弹窗；通用 SubAgentRunner 直接执行
 * - 无 session 计划关联
 * - 仅 spawn → 返回 SubAgentResult.output
 *
 * 返回 tool 消息，结构与其他工具一致（{ ok, data }）。
 */
export async function handleSubAgentRunnerSpawn(
  toolCallId: string,
  rawArgs: string,
  config: AgentRunConfig,
  callbacks: AgentRunnerCallbacks,
  parentSignal?: AbortSignal
): Promise<{ role: 'tool'; tool_call_id: string; name: string; content: string }> {
  const name = 'SubAgentRunner'

  let parsed: {
    subagent_type?: string
    description?: string
    prompt?: string
    task?: string
    context?: string
    expectations?: { questions: string[]; outOfScope?: string[] }
    scope?: { directories?: string[]; excludeGlobs?: string[] }
    depth?: 'quick' | 'normal' | 'exhaustive'
    resume_subagent_id?: string
    review_mode?: 'initial' | 'closure'
    review_cycle_id?: string
    previous_finding_ids?: string[]
  } = {}
  try {
    parsed = JSON.parse(rawArgs || '{}')
  } catch {
    const errMsg = JSON.stringify({ ok: false, error: 'Invalid JSON arguments for SubAgentRunner tool.' })
    callbacks.onToolEnd?.(toolCallId, errMsg)
    return { role: 'tool' as const, tool_call_id: toolCallId, name, content: errMsg }
  }

  const { subagent_type, description, prompt } = parsed

  if (!subagent_type || (!prompt && !parsed.task)) {
    const errMsg = JSON.stringify({
      ok: false,
      error: 'SubAgentRunner requires `subagent_type` and (`prompt` or `task`) arguments.'
    })
    callbacks.onToolEnd?.(toolCallId, errMsg)
    return { role: 'tool' as const, tool_call_id: toolCallId, name, content: errMsg }
  }

  const def = SubAgentManager.getDefinition(subagent_type)
  if (!def) {
    const available = SubAgentManager.listDefinitions()
      .map((d) => d.type)
      .join(', ')
    const errMsg = JSON.stringify({
      ok: false,
      error: `Unknown subagent_type '${subagent_type}'. Registered types: ${available || '(none)'}`
    })
    callbacks.onToolEnd?.(toolCallId, errMsg)
    return { role: 'tool' as const, tool_call_id: toolCallId, name, content: errMsg }
  }

  if (def.type === 'Reviewer') {
    const reviewMode = parsed.review_mode
    const reviewCycleId = parsed.review_cycle_id?.trim() || ''
    const criteria = parsed.expectations?.questions || []
    const previousFindingIds = parsed.previous_finding_ids || []
    if (!['initial', 'closure'].includes(reviewMode || '')) {
      const errMsg = JSON.stringify({
        ok: false,
        error: 'Reviewer requires review_mode="initial" or review_mode="closure".'
      })
      callbacks.onToolEnd?.(toolCallId, errMsg)
      return { role: 'tool' as const, tool_call_id: toolCallId, name, content: errMsg }
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(reviewCycleId)) {
      const errMsg = JSON.stringify({
        ok: false,
        error: 'Reviewer requires a stable review_cycle_id using 1-120 letters, numbers, dot, underscore, colon, or dash.'
      })
      callbacks.onToolEnd?.(toolCallId, errMsg)
      return { role: 'tool' as const, tool_call_id: toolCallId, name, content: errMsg }
    }
    if (criteria.length === 0 || criteria.some((criterion) => !criterion.trim())) {
      const errMsg = JSON.stringify({
        ok: false,
        error: 'Reviewer requires a non-empty frozen acceptance list in expectations.questions.'
      })
      callbacks.onToolEnd?.(toolCallId, errMsg)
      return { role: 'tool' as const, tool_call_id: toolCallId, name, content: errMsg }
    }
    if (reviewMode === 'initial' && previousFindingIds.length > 0) {
      const errMsg = JSON.stringify({ ok: false, error: 'Initial review cannot include previous_finding_ids.' })
      callbacks.onToolEnd?.(toolCallId, errMsg)
      return { role: 'tool' as const, tool_call_id: toolCallId, name, content: errMsg }
    }
    if (
      reviewMode === 'closure' &&
      (!parsed.resume_subagent_id || previousFindingIds.length === 0)
    ) {
      const errMsg = JSON.stringify({
        ok: false,
        error: 'Reviewer closure requires resume_subagent_id and the complete previous_finding_ids list.'
      })
      callbacks.onToolEnd?.(toolCallId, errMsg)
      return { role: 'tool' as const, tool_call_id: toolCallId, name, content: errMsg }
    }
    if (new Set(previousFindingIds).size !== previousFindingIds.length) {
      const errMsg = JSON.stringify({ ok: false, error: 'previous_finding_ids must not contain duplicates.' })
      callbacks.onToolEnd?.(toolCallId, errMsg)
      return { role: 'tool' as const, tool_call_id: toolCallId, name, content: errMsg }
    }
  }

  const resumeSubAgentId = parsed.resume_subagent_id?.trim()
  const typeToken = def.type.replace(/[^A-Za-z0-9._:-]/g, '_')
  const resumeFingerprint = createHash('sha256').update(JSON.stringify({
    type: def.type,
    task: parsed.task || prompt || '',
    context: parsed.context || null,
    expectations: parsed.expectations
      ? {
          questions: parsed.expectations.questions || [],
          outOfScope: parsed.expectations.outOfScope || []
        }
      : null,
    scope: parsed.scope
      ? {
          directories: parsed.scope.directories || [],
          excludeGlobs: parsed.scope.excludeGlobs || []
        }
      : null,
    depth: parsed.depth || null,
    reviewMode: parsed.review_mode || null,
    reviewCycleId: parsed.review_cycle_id || null,
    previousFindingIds: parsed.previous_finding_ids || []
  })).digest('hex').slice(0, 16)
  const resumePrefix = `subagent_${typeToken}_${resumeFingerprint}_`
  const isReviewerClosure = def.type === 'Reviewer' && parsed.review_mode === 'closure'
  if (
    resumeSubAgentId &&
    (
      resumeSubAgentId.length > 512 ||
      /[\u0000-\u001f]/.test(resumeSubAgentId) ||
      !resumeSubAgentId.startsWith(isReviewerClosure ? `subagent_${typeToken}_` : resumePrefix)
    )
  ) {
    const errMsg = JSON.stringify({
      ok: false,
      error: `SubAgentRunner \`resume_subagent_id\` is invalid for subagent type '${def.type}'.`
    })
    callbacks.onToolEnd?.(toolCallId, errMsg)
    return { role: 'tool' as const, tool_call_id: toolCallId, name, content: errMsg }
  }

  const closureReferenceError = await validateReviewerClosureReference(parsed, config)
  if (closureReferenceError) {
    const errMsg = JSON.stringify({ ok: false, error: closureReferenceError })
    callbacks.onToolEnd?.(toolCallId, errMsg)
    return { role: 'tool' as const, tool_call_id: toolCallId, name, content: errMsg }
  }
  const initialCycleError = await validateReviewerInitialCycle(parsed, config, toolCallId)
  if (initialCycleError) {
    const errMsg = JSON.stringify({ ok: false, error: initialCycleError })
    callbacks.onToolEnd?.(toolCallId, errMsg)
    return { role: 'tool' as const, tool_call_id: toolCallId, name, content: errMsg }
  }

  // 通知前端 SubAgent 开始运行（复用 Plan 的进度通道，UI 已接听）
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    win.webContents.send(IPC_CHANNELS.PLAN_SUBAGENT_PROGRESS, { status: 'running' })
  }

  // 生成与父工具调用绑定的 subAgentId，并通知前端开始（驱动 SubAgentCard）
  const subAgentId = resumeSubAgentId || `${resumePrefix}${toolCallId}`
  callbacks.onSubAgentStart?.(subAgentId, {
    type: subagent_type,
    description: description || '',
    prompt: parsed.task || prompt || '',
    depth: parsed.depth,
    expectations: parsed.expectations,
    context: parsed.context,
    scope: parsed.scope,
    reviewMode: parsed.review_mode,
    reviewCycleId: parsed.review_cycle_id,
    previousFindingIds: parsed.previous_finding_ids,
    parentToolCallId: toolCallId
  })

  try {
    const result = await SubAgentManager.spawn(
      subagent_type,
      {
        workspaceRoot: config.workspaceRoot,
        sessionId: config.sessionId || 'session_default',
        providerId: config.providerId,
        task: parsed.task || prompt || '',
        parentPrompt: parsed.task || prompt || '',
        subAgentId,
        resumeSubAgentId,
        reviewMode: parsed.review_mode,
        reviewCycleId: parsed.review_cycle_id,
        previousFindingIds: parsed.previous_finding_ids,
        expectations: parsed.expectations,
        context: parsed.context,
        scope: parsed.scope,
        depth: parsed.depth,
        contextCapabilities: config.contextCapabilities,
        runtimeCoordinator: config.runtimeCoordinator,
        contextBuilder: config.contextBuilder,
        compactionService: config.compactionService,
        parentSignal,
        permissionScope: def.allowShell
          ? { allowBash: true, allowedWriteFiles: [], shellPolicy: def.shellPolicy }
          : undefined,
        apiConfig: {
          baseUrl: config.baseUrl || '',
          apiKey: config.apiKey || '',
          apiFormat: config.apiFormat || 'openai',
          model: config.model || '',
          thinking: config.thinking,
          contextWindowTokens: config.contextCapabilities?.contextWindowTokens,
          maxInputTokens: config.contextCapabilities?.maxInputTokens,
          maxOutputTokens: config.contextCapabilities?.maxOutputTokens,
          reasoningCountsAgainstContext: config.contextCapabilities?.reasoningCountsAgainstContext
        }
      },
      callbacks
    )

    if (win) {
      win.webContents.send(IPC_CHANNELS.PLAN_SUBAGENT_PROGRESS, { status: result.status })
    }

    const exposedOutput = result.status === 'completed'
      ? result.output || ''
      : truncateBridgeText(result.output || 'SubAgent did not complete.', 4000)
    callbacks.onSubAgentEnd?.(subAgentId, {
      status: result.status,
      output: exposedOutput,
      qualitySummary: result.status === 'completed' ? result.qualitySummary : undefined,
      toolCallCount: result.toolCallCount,
      filesExamined: result.filesExamined,
      conclusion: result.structuredOutput?.conclusion,
      handoff: result.handoff
    })

    const resultData = {
      status: result.status,
      subagent_type,
      description: truncateBridgeText(description || '', 200),
      output: exposedOutput || '(subagent produced no text output)',
      structuredOutput: result.status === 'completed' ? result.structuredOutput : undefined,
      qualitySummary: result.status === 'completed' ? result.qualitySummary : undefined,
      toolCallCount: result.toolCallCount,
      filesExamined: result.filesExamined?.slice(-20).map((value) =>
        truncateBridgeText(value, 240)
      ),
      subagent_id: subAgentId,
      review_mode: parsed.review_mode,
      review_cycle_id: parsed.review_cycle_id,
      handoff: result.handoff,
      resume_subagent_id: (
        result.handoff?.canResume ||
        result.status === 'interrupted' ||
        (
          def.type === 'Reviewer' &&
          parsed.review_mode === 'initial' &&
          (result.structuredOutput as Record<string, unknown> | undefined)?.verdict === 'BLOCKED'
        )
      )
        ? subAgentId
        : undefined,
    }
    const resultMsg = JSON.stringify(
      result.status === 'completed'
        ? { ok: true, data: resultData }
        : result.status === 'interrupted'
          ? {
              ok: false,
              error: {
                code: 'EXECUTION_INTERRUPTED',
                message: exposedOutput || `SubAgent '${subagent_type}' was interrupted.`
              },
              data: resultData
            }
          : {
              ok: false,
              error: exposedOutput || `SubAgent '${subagent_type}' did not submit a valid result.`,
              data: resultData
            }
    )
    callbacks.onToolEnd?.(toolCallId, resultMsg)
    return { role: 'tool' as const, tool_call_id: toolCallId, name, content: resultMsg }
  } catch (err: any) {
    if (win) {
      win.webContents.send(IPC_CHANNELS.PLAN_SUBAGENT_PROGRESS, { status: 'failed' })
    }
    const rawReason = err instanceof Error ? err.message : String(err)
    const reason = truncateBridgeText(rawReason, 1200)
    const handoff: SubAgentHandoff = {
      reasonCode: 'runtime_error',
      reason,
      originalTask: truncateBridgeText(parsed.task || prompt || '', 2500),
      knownContext: parsed.context
        ? truncateBridgeText(parsed.context, 1200)
        : undefined,
      scope: parsed.scope
        ? {
            directories: parsed.scope.directories?.slice(0, 10).map((value) =>
              truncateBridgeText(value, 160)
            ),
            excludeGlobs: parsed.scope.excludeGlobs?.slice(0, 10).map((value) =>
              truncateBridgeText(value, 160)
            )
          }
        : undefined,
      expectations: parsed.expectations
        ? {
            questions: parsed.expectations.questions.slice(0, 12).map((value) =>
              truncateBridgeText(value, 240)
            ),
            outOfScope: parsed.expectations.outOfScope?.slice(0, 8).map((value) =>
              truncateBridgeText(value, 240)
            )
          }
        : undefined,
      depth: parsed.depth,
      filesExamined: [],
      filesModified: [],
      filesPossiblyModified: [],
      recentTools: [],
      workspaceMayHaveUntrackedChanges: false,
      canResume: false
    }
    callbacks.onSubAgentEnd?.(subAgentId, {
      status: 'failed',
      output: reason,
      toolCallCount: 0,
      handoff
    })
    const errMsg = JSON.stringify({
      ok: false,
      error: `SubAgent '${subagent_type}' execution failed: ${reason}`,
      data: {
        status: 'failed',
        subagent_type,
        description: description || '',
        handoff
      }
    })
    callbacks.onToolEnd?.(toolCallId, errMsg)
    return { role: 'tool' as const, tool_call_id: toolCallId, name, content: errMsg }
  }
}
