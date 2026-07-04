import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'

import { getProviderService } from './provider.handlers'
import { getWorkspaceService } from './workspace.handlers'
import type { ChatMessage } from '../../shared/types/provider'

interface StreamRequest {
  providerId: string
  model: string
  messages: ChatMessage[]
  sessionId?: string
}

import type { AgentRunner } from '../agent/AgentRunner'
const activeRunners = new Map<string, AgentRunner>()

export function registerChatIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.CHAT_STREAM_START,
    async (event, request: StreamRequest): Promise<string> => {
      const streamId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      const sender = event.sender
      const win = BrowserWindow.fromWebContents(sender)
      if (!win) {
        throw new Error('无法获取窗口引用')
      }

      const providerSvc = getProviderService()
      const config = providerSvc.getConfig(request.providerId)
      if (!config) {
        sender.send(IPC_CHANNELS.CHAT_STREAM_ERROR, streamId, 'Provider 不存在')
        return streamId
      }

      const apiKey = providerSvc.getApiKey(request.providerId)
      if (!apiKey) {
        sender.send(IPC_CHANNELS.CHAT_STREAM_ERROR, streamId, '无法获取 API Key')
        return streamId
      }

      const workspaceSvc = getWorkspaceService()
      const currentWorkspace = workspaceSvc ? workspaceSvc.getCurrentWorkspace() : null
      if (!currentWorkspace) {
        sender.send(IPC_CHANNELS.CHAT_STREAM_ERROR, streamId, '当前未打开任何工作区，无法启动 Agent')
        return streamId
      }

      const modelConfig = config.models?.find(m => m.id === request.model || m.name === request.model)
      const contextWindowTokens = modelConfig?.maxContextTokens || 32000

      const { AgentRunner } = await import('../agent/AgentRunner')
      const runner = new AgentRunner()
      activeRunners.set(streamId, runner)

      const { SystemPromptService } = await import('../services/SystemPromptService')

      const sysPrompt = await SystemPromptService.buildSystemPrompt({
        workspaceRoot: currentWorkspace,
        modelId: request.model,
        modelDisplayName: `${modelConfig?.name || request.model} (${contextWindowTokens.toLocaleString()} context)`,
        contextWindowTokens,
        sessionId: request.sessionId
      })

      const messages: ChatMessage[] = [
        { role: 'system', content: sysPrompt },
        ...request.messages
      ]

      // Inject <system_reminder> before the first user message
      const reminder = await SystemPromptService.buildSystemReminder(currentWorkspace)
      if (reminder && messages.length > 1 && messages[1]?.role === 'user') {
        messages[1] = {
          ...messages[1],
          content: reminder + '\n\n' + messages[1].content
        }
      }

      // 异步执行 Agent 循环，通过 webContents.send 推送
      runner.run(
        {
          baseUrl: config.baseUrl,
          apiFormat: modelConfig?.apiFormat || config.apiFormat,
          apiKey,
          model: request.model,
          messages,
          workspaceRoot: currentWorkspace,
          thinking: modelConfig?.thinkingMode 
            ? { ...config.thinking, mode: modelConfig.thinkingMode }
            : config.thinking,
          sessionId: request.sessionId || undefined,
          contextWindowTokens
        },
        {
          onChunk: (delta, reasoningDelta) => {
            sender.send(IPC_CHANNELS.CHAT_STREAM_CHUNK, streamId, delta, reasoningDelta)
          },
          onDone: (fullContent, stopReason, txId) => {
            sender.send(IPC_CHANNELS.CHAT_STREAM_END, streamId, fullContent, stopReason, txId)
            activeRunners.delete(streamId)
          },
          onError: (error) => {
            sender.send(IPC_CHANNELS.CHAT_STREAM_ERROR, streamId, error)
            activeRunners.delete(streamId)
          },
          onToolStart: (toolCallId, name, args, thoughtSignature) => {
            sender.send(IPC_CHANNELS.CHAT_STREAM_TOOL_START, streamId, toolCallId, name, args, thoughtSignature)
          },
          onToolEnd: (toolCallId, result) => {
            sender.send(IPC_CHANNELS.CHAT_STREAM_TOOL_END, streamId, toolCallId, result)
          },
          onPermissionRequest: async (request) => {
            return new Promise((resolve) => {
              sender.send(IPC_CHANNELS.CHAT_REQUEST_APPROVAL, streamId, request)
              const responseChannel = `${IPC_CHANNELS.CHAT_APPROVAL_RESPONSE}:${request.id}`
              ipcMain.handleOnce(responseChannel, (_event, approved: boolean) => {
                resolve(approved)
              })
            })
          },
          onAskUserRequest: (request) => {
            return new Promise((resolve) => {
              sender.send(IPC_CHANNELS.CHAT_REQUEST_ASK_USER, streamId, request)
              const responseChannel = `${IPC_CHANNELS.CHAT_ASK_USER_RESPONSE}:${request.id}`
              ipcMain.handleOnce(responseChannel, (_event, answers) => {
                resolve(answers || [])
              })
            })
          },
          onPlanReview: (plan) => {
            return new Promise((resolve) => {
              sender.send('plan:review-request', streamId, plan)
              planReviewResolvers.set(streamId, resolve)
            })
          }
        }
      ).catch((error) => {
        sender.send(IPC_CHANNELS.CHAT_STREAM_ERROR, streamId, `未知错误: ${error}`)
        activeRunners.delete(streamId)
      })

      return streamId
    }
  )

  ipcMain.handle(IPC_CHANNELS.CHAT_STREAM_STOP, (_event, streamId: string) => {
    const runner = activeRunners.get(streamId)
    if (runner) {
      runner.abort()
      activeRunners.delete(streamId)
    }
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_ACCEPT_FILE, async (_event, txId: string, filePath: string) => {
    const { getEditTransactionService } = await import('../services/EditTransactionService')
    const svc = getEditTransactionService()
    return await svc.commitFile(txId, filePath)
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_REJECT_FILE, async (_event, txId: string, filePath: string) => {
    const { getEditTransactionService } = await import('../services/EditTransactionService')
    const svc = getEditTransactionService()
    return await svc.rollbackFile(txId, filePath)
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_GET_DIFF, async (_event, txId: string) => {
    const { getEditTransactionService } = await import('../services/EditTransactionService')
    const svc = getEditTransactionService()
    return await svc.getDiff(txId)
  })

  // Plan 审批 IPC（per-stream 决策）
  const planReviewResolvers = new Map<string, (decision: { approved: boolean; feedback?: string }) => void>()

  ipcMain.handle(IPC_CHANNELS.PLAN_APPROVE, (_event, streamId: string, planSlug: string) => {
    const resolver = planReviewResolvers.get(streamId)
    if (resolver) {
      resolver({ approved: true })
      planReviewResolvers.delete(streamId)
      return true
    }
    return false
  })

  ipcMain.handle(IPC_CHANNELS.PLAN_REJECT, (_event, streamId: string, planSlug: string, feedback: string) => {
    const resolver = planReviewResolvers.get(streamId)
    if (resolver) {
      resolver({ approved: false, feedback })
      planReviewResolvers.delete(streamId)
      return true
    }
    return false
  })

  // planReviewResolvers is available via the module scope for AgentRunner use
}
