import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../../shared/ipc/channels'
import { SubAgentManager } from '../SubAgentManager'
import { PlanStore } from '../../services/PlanStore'
import { getSessionStore } from '../../ipc/session.handlers'
import type { AgentRunnerCallbacks } from './types'

export async function handleEnterPlanMode(
  toolCallId: string,
  allMessages: any[],
  config: any,
  callbacks: AgentRunnerCallbacks,
  planStore: PlanStore,
  toolManager: any,
  availableTools: any[]
): Promise<{ role: 'tool'; tool_call_id: string; name: string; content: string }> {
  const name = 'EnterPlanMode'
  if (!callbacks.onAskUserRequest) {
    const msg = JSON.stringify({ ok: false, error: 'UI handler for AskUserRequest not available.' })
    callbacks.onToolEnd?.(toolCallId, msg)
    return { role: 'tool' as const, tool_call_id: toolCallId, name, content: msg }
  }

  const answers = await callbacks.onAskUserRequest({
    id: `plan_confirm_${Date.now()}`,
    questions: [
      {
        question: 'Agent 建议进入 Plan 模式以探索代码并设计技术方案，是否同意？',
        header: '🏗️ Agent 建议进入 Plan 模式',
        options: [
          { label: '进入规划', description: '启动 Plan SubAgent 进行分析设计' },
          { label: '跳过，直接执行', description: 'Agent 将继续在当前模式下直接工作' }
        ],
        multiSelect: false
      }
    ]
  })

  const ans = answers?.[0]?.answer as string
  if (ans === 'approve') {
    try {
      const lastUserMsg = [...allMessages].reverse().find((m) => m.role === 'user')
      const parentPrompt = lastUserMsg
        ? typeof lastUserMsg.content === 'string'
          ? lastUserMsg.content
          : JSON.stringify(lastUserMsg.content)
        : 'Create an implementation plan.'

      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        win.webContents.send(IPC_CHANNELS.PLAN_SUBAGENT_PROGRESS, { status: 'running' })
      }

      const result = await SubAgentManager.spawn(
        'Plan',
        {
          workspaceRoot: config.workspaceRoot,
          sessionId: config.sessionId || 'session_default',
          task: parentPrompt,
          parentPrompt,
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

      const activePlan = await planStore.getActive(config.workspaceRoot)
      if (activePlan) {
        const sessionStore = getSessionStore()
        const session = sessionStore.getAll().find((s: any) => s.id === config.sessionId)
        if (session) {
          session.linkedPlanSlug = activePlan.slug
          await sessionStore.save(session)

          if (win) {
            win.webContents.send(IPC_CHANNELS.PLAN_LINKED, {
              sessionId: config.sessionId,
              plan: activePlan
            })
          }
        }
        const stepLines = activePlan.steps
          .map((s: any) => `- [${s.status}] ${s.id} ${s.title}`)
          .join('\n')
        const planMsg = [
          '<active_plan>',
          `Plan: ${activePlan.title} (slug: ${activePlan.slug})`,
          `Status: ${activePlan.status}`,
          'Steps:',
          stepLines,
          '</active_plan>'
        ].join('\n')

        const filteredMessages = allMessages.filter(
          (m) =>
            !(
              m.role === 'system' &&
              typeof m.content === 'string' &&
              m.content.includes('<active_plan>')
            )
        )
        allMessages.length = 0
        allMessages.push(...filteredMessages, { role: 'system', content: planMsg })

        if (!availableTools.find((t) => t.function.name === 'UpdatePlanStep')) {
          const stepTool = toolManager.getTool('UpdatePlanStep')
          if (stepTool) {
            availableTools.push({
              type: 'function' as const,
              function: {
                name: stepTool.name,
                description: stepTool.description,
                parameters: stepTool.parameters_schema
              }
            })
          }
        }
      }

      const exitResultMsg = JSON.stringify({
        ok: true,
        data: {
          status: 'plan_completed',
          message:
            'Plan mode completed. If a plan was approved, an <active_plan> has been injected. Please execute the plan now.',
          subAgentResult: result
        }
      })

      callbacks.onToolEnd?.(toolCallId, exitResultMsg)
      return { role: 'tool' as const, tool_call_id: toolCallId, name, content: exitResultMsg }
    } catch (err: any) {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) win.webContents.send(IPC_CHANNELS.PLAN_SUBAGENT_PROGRESS, { status: 'failed' })

      const errMsg = JSON.stringify({
        ok: false,
        error: 'Plan SubAgent execution failed: ' + err.message
      })
      callbacks.onToolEnd?.(toolCallId, errMsg)
      return { role: 'tool' as const, tool_call_id: toolCallId, name, content: errMsg }
    }
  } else {
    const exitResultMsg = JSON.stringify({
      ok: true,
      data: { status: 'skipped', message: 'User chose to skip planning. Proceed directly.' }
    })
    callbacks.onToolEnd?.(toolCallId, exitResultMsg)
    return { role: 'tool' as const, tool_call_id: toolCallId, name, content: exitResultMsg }
  }
}
