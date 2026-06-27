import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import { AgentRunner } from '../agent/AgentRunner'
import { getProviderService } from './provider.handlers'
import { getWorkspaceService } from './workspace.handlers'
import type { ChatMessage } from '../../shared/types/provider'

interface StreamRequest {
  providerId: string
  model: string
  messages: ChatMessage[]
}

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

      const runner = new AgentRunner()
      activeRunners.set(streamId, runner)

      // 异步执行 Agent 循环，通过 webContents.send 推送
      runner.run(
        {
          baseUrl: config.baseUrl,
          apiFormat: config.apiFormat,
          apiKey,
          model: request.model,
          messages: [
            {
              role: 'system',
              content: [
                'You are a helpful AI programming assistant.',
                'You have access to various tools. Choose the most efficient tool for each task based on its description.'
              ].join('\n')
            },
            ...request.messages
          ],
          workspaceRoot: currentWorkspace,
          thinking: config.thinking
        },
        {
          onChunk: (delta, reasoningDelta) => {
            sender.send(IPC_CHANNELS.CHAT_STREAM_CHUNK, streamId, delta, reasoningDelta)
          },
          onDone: (fullContent, txId) => {
            sender.send(IPC_CHANNELS.CHAT_STREAM_END, streamId, fullContent, txId)
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
}
