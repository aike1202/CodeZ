import { SubAgentManager } from '../SubAgentManager'
import { BrowserWindow } from 'electron'
import { createHash } from 'crypto'
import { IPC_CHANNELS } from '../../../shared/ipc/channels'
import type { AgentRunConfig, AgentRunnerCallbacks } from './types'
import type { SubAgentHandoff } from '../../../shared/types/subagent'

function truncateBridgeText(value: string, maxLength: number): string {
  const normalized = value.trim()
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength)}\n...[truncated]`
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
    depth: parsed.depth || null
  })).digest('hex').slice(0, 16)
  const resumePrefix = `subagent_${typeToken}_${resumeFingerprint}_`
  if (
    resumeSubAgentId &&
    (
      resumeSubAgentId.length > 512 ||
      /[\u0000-\u001f]/.test(resumeSubAgentId) ||
      !resumeSubAgentId.startsWith(resumePrefix)
    )
  ) {
    const errMsg = JSON.stringify({
      ok: false,
      error: `SubAgentRunner \`resume_subagent_id\` is invalid for subagent type '${def.type}'.`
    })
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
        expectations: parsed.expectations,
        context: parsed.context,
        scope: parsed.scope,
        depth: parsed.depth,
        contextCapabilities: config.contextCapabilities,
        runtimeCoordinator: config.runtimeCoordinator,
        contextBuilder: config.contextBuilder,
        compactionService: config.compactionService,
        parentSignal,
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
      handoff: result.handoff,
      resume_subagent_id: result.handoff?.canResume || result.status === 'interrupted'
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
