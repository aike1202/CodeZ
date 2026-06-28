import { ipcMain, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
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

      const { SkillManager } = await import('../services/SkillManager')
      const sm = SkillManager.getInstance()
      const activeSkills = await sm.getActiveSkills(currentWorkspace)
      
      let systemPrompt = `You are a helpful AI programming assistant.
You have access to various tools. Choose the most efficient tool for each task based on its description.

<environment_context>
  <cwd>${currentWorkspace}</cwd>
  <os>${os.type()} ${os.release()}</os>
  <current_time>${new Date().toISOString()}</current_time>
</environment_context>

<rules>
  【CRITICAL RULES FOR FILE EDITING】
  1. When modifying existing files, always prefer using the targeted "replace_file_content" tool to perform partial edits.
  2. NEVER use "write_to_file" to edit, modify, or update existing files unless you are writing a brand new file, or you need to rewrite 100% of the file contents because the file is entirely changed.
`

      // 自动加载本地全局规则
      const agentsMdPath = path.join(currentWorkspace, 'AGENTS.md')
      if (fs.existsSync(agentsMdPath)) {
        try {
          const rulesContent = fs.readFileSync(agentsMdPath, 'utf-8')
          systemPrompt += `\n  【PROJECT LOCAL RULES】\n  ${rulesContent}\n`
        } catch (e) {
          console.error('Failed to read AGENTS.md', e)
        }
      }
      systemPrompt += `</rules>\n`

      if (activeSkills.length > 0) {
        systemPrompt += '\n<skills_instructions>\n'
        systemPrompt += 'Below is the list of active skills. Each entry includes a name, description, and the file path.\n'
        systemPrompt += 'IMPORTANT: Before using a skill, you MUST use the "view_file" or "read_file" tool to read the markdown file at its path to understand the detailed instructions.\n\n'
        for (const skill of activeSkills) {
          systemPrompt += `- ${skill.name}: ${skill.description}\n  Path: ${skill.path || 'Unknown'}\n`
        }
        systemPrompt += '</skills_instructions>\n'
      }

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
              content: systemPrompt
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
