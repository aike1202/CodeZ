import { SubAgentManager } from '../SubAgentManager'
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../../shared/ipc/channels'
import type { AgentRunnerCallbacks } from './types'

/**
 * 通用子智能体 spawn 拦截处理。
 *
 * 与 planRunnerHelper 的区别：
 * - 无批准弹窗（Plan 的弹窗源于 EnterPlanMode 的特殊 UX；通用 Task 直接执行）
 * - 无 <active_plan> 注入 / session 关联
 * - 仅 spawn → 返回 SubAgentResult.output
 *
 * 返回 tool 消息，结构与其他工具一致（{ ok, data }）。
 */
export async function handleTaskSpawn(
  toolCallId: string,
  rawArgs: string,
  config: { workspaceRoot: string; sessionId?: string; baseUrl?: string; apiKey?: string; apiFormat?: string; model?: string; thinking?: boolean },
  callbacks: AgentRunnerCallbacks
): Promise<{ role: 'tool'; tool_call_id: string; name: string; content: string }> {
  const name = 'Task'

  let parsed: { subagent_type?: string; description?: string; prompt?: string } = {}
  try {
    parsed = JSON.parse(rawArgs || '{}')
  } catch {
    const errMsg = JSON.stringify({ ok: false, error: 'Invalid JSON arguments for Task tool.' })
    callbacks.onToolEnd?.(toolCallId, errMsg)
    return { role: 'tool' as const, tool_call_id: toolCallId, name, content: errMsg }
  }

  const { subagent_type, description, prompt } = parsed

  if (!subagent_type || !prompt) {
    const errMsg = JSON.stringify({
      ok: false,
      error: 'Task requires `subagent_type` and `prompt` arguments.'
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

  // 通知前端 SubAgent 开始运行（复用 Plan 的进度通道，UI 已接听）
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    win.webContents.send(IPC_CHANNELS.PLAN_SUBAGENT_PROGRESS, { status: 'running' })
  }

  try {
    const result = await SubAgentManager.spawn(
      subagent_type,
      {
        workspaceRoot: config.workspaceRoot,
        sessionId: config.sessionId || 'session_default',
        parentPrompt: prompt,
        apiConfig: {
          baseUrl: config.baseUrl || '',
          apiKey: config.apiKey || '',
          apiFormat: config.apiFormat || 'openai',
          model: config.model || '',
          thinking: config.thinking as any
        }
      },
      callbacks
    )

    if (win) {
      win.webContents.send(IPC_CHANNELS.PLAN_SUBAGENT_PROGRESS, { status: 'completed' })
    }

    const resultMsg = JSON.stringify({
      ok: true,
      data: {
        status: 'completed',
        subagent_type,
        description: description || '',
        output: result.output || '(subagent produced no text output)',
        toolCallCount: result.toolCallCount
      }
    })
    callbacks.onToolEnd?.(toolCallId, resultMsg)
    return { role: 'tool' as const, tool_call_id: toolCallId, name, content: resultMsg }
  } catch (err: any) {
    if (win) {
      win.webContents.send(IPC_CHANNELS.PLAN_SUBAGENT_PROGRESS, { status: 'failed' })
    }
    const errMsg = JSON.stringify({
      ok: false,
      error: `SubAgent '${subagent_type}' execution failed: ${err.message}`
    })
    callbacks.onToolEnd?.(toolCallId, errMsg)
    return { role: 'tool' as const, tool_call_id: toolCallId, name, content: errMsg }
  }
}
