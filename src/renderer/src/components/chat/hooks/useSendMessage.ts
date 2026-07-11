import { useCallback } from 'react'
import { useWorkspaceStore } from '../../../stores/workspaceStore'
import { useProviderStore } from '../../../stores/providerStore'
import { useChatStore } from '../../../stores/chatStore'
import { parseSlashCommand } from '../../../commands/SlashCommandParser'
import type { SkillDefinition } from '../../../../../shared/types/skill'
import type { ToolBatchMeta } from '../../../../../shared/types/toolExecution'
import type { ComposerImageAttachment, ImageAttachment } from '../../../../../shared/types/attachment'
import { supportsImageInput } from '../../../../../shared/utils/imageCapabilities'

export function buildChatStreamInput(
  message: string,
  dynamicSkills: SkillDefinition[],
  uiMessageId: string,
  isSystem = false,
  attachments: ImageAttachment[] = []
) {
  const parsed = isSystem ? { isCommand: false, processedMessage: message } : parseSlashCommand(message, dynamicSkills)
  let text = parsed.isCommand ? parsed.processedMessage : message
  const referencedFiles: string[] = []
  const fileRegex = /\[([^$\]][^\]]*)\]\(([^)]+)\)/g
  let match: RegExpExecArray | null
  while ((match = fileRegex.exec(text)) !== null) referencedFiles.push(match[2])
  if (referencedFiles.length > 0) {
    text += `\n\n【系统提示：用户在本次交互中明确引用了以下工作区文件：\n${referencedFiles.map((file) => `- ${file}`).join('\n')}\n如需了解其详细内容，请主动调用 read_file 工具读取。】`
  }
  return {
    text,
    isSystem,
    ...(attachments.length ? { attachments } : {}),
    commandMetadata: {
      uiMessageId,
      commandName: parsed.isCommand ? parsed.commandName : undefined,
      referencedFiles
    }
  }
}

function genId(): string {
  return '_' + Math.random().toString(36).substring(2, 9)
}

export interface SendMessageOptions {
  visibility?: 'visible' | 'internal'
}

export function useSendMessage() {
  const addUserMessage = useChatStore((s) => s.addUserMessage)
  const startStreamingReply = useChatStore((s) => s.startStreamingReply)
  const appendStreamChunk = useChatStore((s) => s.appendStreamChunk)
  const finishStreaming = useChatStore((s) => s.finishStreaming)
  const persistCurrentSession = useChatStore((s) => s.persistCurrentSession)
  const setStreamCleanup = useChatStore((s) => s.setStreamCleanup)
  const createSession = useChatStore((s) => s.createSession)
  const startToolCall = useChatStore((s) => s.startToolCall)
  const finishToolCall = useChatStore((s) => s.finishToolCall)
  const appendReasoningTimelineChunk = useChatStore((s) => s.appendReasoningTimelineChunk)
  const addPermissionRequest = useChatStore((s) => s.addPermissionRequest)
  const addAskUserRequest = useChatStore((s) => s.addAskUserRequest)
  const setDiffEntries = useChatStore((s) => s.setDiffEntries)
  const startSubAgent = useChatStore((s) => s.startSubAgent)
  const appendSubAgentChunk = useChatStore((s) => s.appendSubAgentChunk)
  const startSubAgentToolCall = useChatStore((s) => s.startSubAgentToolCall)
  const finishSubAgentToolCall = useChatStore((s) => s.finishSubAgentToolCall)
  const endSubAgent = useChatStore((s) => s.endSubAgent)
  const removeMessages = useChatStore((s) => s.removeMessages)

  const handleSendMessage = useCallback(
    async (
      message: string,
      modelName: string,
      isSystem = false,
      attachments: ComposerImageAttachment[] = [],
      options: SendMessageOptions = {}
    ): Promise<boolean> => {
      const internal = options.visibility === 'internal'
      const ws = useWorkspaceStore.getState().workspace
      if (!ws) {
        alert('请先选择或打开一个项目工作区才能发送消息！')
        return false
      }

      let allSkills: any[] = []
      try {
        allSkills = await (window as any).api.skill.getAll(ws.rootPath)
      } catch (e) {}

      // Parse slash commands to check for client-side actions before anything else
      let clientAction = null
      let parseResult: any = {}
      if (!isSystem) {
        parseResult = parseSlashCommand(message, allSkills)
        clientAction = parseResult.clientAction
      }

      if (clientAction) {
        if (clientAction.type === 'context:compact') {
          const sessionId = useChatStore.getState().activeSessionId
          if (!sessionId) return false
          useChatStore.getState().setCompactionState(sessionId, { status: 'running', trigger: 'manual' })
          try {
            const response = await (window as any).api.chat.compact(
              sessionId,
              clientAction.payload?.instructions || undefined
            )
            useChatStore.getState().setCompactionState(sessionId, response?.accepted
              ? { status: 'completed', trigger: 'manual', ...response.result }
              : { status: 'failed', trigger: 'manual', error: response?.reason || response?.result?.message || 'Compaction failed' })
          } catch (error) {
            useChatStore.getState().setCompactionState(sessionId, {
              status: 'failed', trigger: 'manual', error: error instanceof Error ? error.message : String(error)
            })
          }
          return true
        }
        if (clientAction.type === 'plan:show-list') {
          useChatStore.getState().setPlanListModalOpen(true)
          return true
        }
        if (clientAction.type === 'plan:load') {
          const slug = clientAction.payload?.slug
          if (slug) {
            try {
              const plan = await (window as any).api.plan.load(ws.rootPath, slug)
              useChatStore.getState().setActivePlan(plan)
              useChatStore.getState().setExpandedCapsule('plan')
            } catch (err) {
              console.error('[useSendMessage] Failed to load plan:', err)
            }
          }
          return true
        }
        if (clientAction.type === 'plan:new') {
          // agent 将在收到 slash 命令后自动判断是否发起 Plan 提案
          // Send the description as a normal user message to the AI
          const description = clientAction.payload?.description || message
          if (!description) return false
          // Use processedMessage from the parse result (the description text)
          message = parseResult.processedMessage || description
        }
        // For other client actions, continue normally (fall through)
        // but only if processedMessage is not empty
        if (!parseResult.processedMessage) return true
      }

      const provState = useProviderStore.getState()
      const activeProv = provState.providers.find((p) => p.id === provState.activeProviderId)
      if (!activeProv) {
        if (attachments.length > 0) {
          alert('请先配置支持图片输入的模型 Provider。')
          return false
        }
        if (internal) {
          // Internal recovery creates only the Agent reply, never a prompt message.
        } else if (isSystem) {
          useChatStore.getState().addSystemMessage(message)
        } else {
          addUserMessage(message)
        }
        const agentId = startStreamingReply()
        const simText = `请先配置模型 Provider 才能进行 AI 对话。\n\n点击输入框左侧齿轮图标打开设置，添加一个 OpenAI-compatible Provider（如 OpenAI、Ollama、DeepSeek 等）。\n\n配置完成后，输入消息即可获得 AI 实时流式回复。`

        let simSid = useChatStore.getState().activeSessionId
        if (!simSid) {
          simSid = createSession(ws.id)
        }

        let i = 0
        const interval = setInterval(() => {
          if (i < simText.length) {
            appendStreamChunk(agentId, simText[i])
            i++
          } else {
            clearInterval(interval)
            finishStreaming(agentId)
            persistCurrentSession()
          }
        }, 15)
        setStreamCleanup(simSid, () => () => clearInterval(interval))
        return true
      }

      const model = modelName || activeProv.models[0]?.name || 'gpt-4o'
      const modelConfig = activeProv.models.find((item) => item.name === model || item.id === model)
      if (attachments.length > 0 && !supportsImageInput(modelConfig)) {
        alert('当前模型未启用图片输入，请切换模型或在模型设置中开启。')
        return false
      }

      let sid = useChatStore.getState().activeSessionId
      if (!sid) {
        sid = createSession(ws.id)
        
        const currentPlan = useChatStore.getState().activePlan
        if (currentPlan) {
          useChatStore.getState().linkPlanToSession(sid, currentPlan.slug)
        }
      }

      let promotedAttachments: ImageAttachment[] = []
      try {
        promotedAttachments = attachments.length > 0
          ? await window.api.attachment.promoteDrafts(sid, attachments)
          : []
      } catch (error) {
        alert(`照片导入失败：${error instanceof Error ? error.message : String(error)}`)
        return false
      }

      let uiMessageId: string
      if (internal) {
        uiMessageId = `internal_${genId()}`
      } else if (isSystem) {
        uiMessageId = useChatStore.getState().addSystemMessage(message).id
      } else {
        uiMessageId = addUserMessage(message, promotedAttachments).id
      }
      await useChatStore.getState().persistSession(sid)
      const agentId = startStreamingReply()

      const streamInput = buildChatStreamInput(
        message,
        allSkills,
        uiMessageId,
        isSystem,
        isSystem ? [] : promotedAttachments
      )

      // 前端兜底 watchdog：90s 无首字节提示（后端 60s watchdog 通常先触发，此为兜底）
      let firstByteTimer: ReturnType<typeof setTimeout> | null = null
      let gotFirstByte = false

      const streamHandle = (window as any).api.chat.stream(
        activeProv.id,
        model,
        sid,
        streamInput,
        {
          onChunk: (delta: string, reasoningDelta?: string) => {
            if (!gotFirstByte) {
              gotFirstByte = true
              if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null }
            }
            appendStreamChunk(agentId, delta, reasoningDelta)
            appendReasoningTimelineChunk(agentId, reasoningDelta || '')
          },
          onDone: async (fullContent: string, _stopReason?: string, txId?: string) => {
            if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null }
            finishStreaming(agentId, txId)
            if (txId) {
              useChatStore.getState().setTransactionId(agentId, txId)
              try {
                const diffs = await window.api.chat.getDiff(txId)
                if (Array.isArray(diffs) && diffs.length > 0) {
                  setDiffEntries(agentId, diffs)
                }
              } catch (err) {
                console.warn('Failed to load transaction diff:', err)
              }
            }
            useChatStore.getState().persistSession(sid)
            setStreamCleanup(sid, null)
          },
          onError: (error: string) => {
            if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null }
            appendStreamChunk(agentId, `\n\n⚠️ 错误：${error}`)
            finishStreaming(agentId)
            useChatStore.getState().persistSession(sid)
            setStreamCleanup(sid, null)
          },
          onToolStart: (
            toolCallId: string,
            name: string,
            args: string,
            thoughtSignature?: string,
            batch?: ToolBatchMeta
          ) => {
            startToolCall(agentId, {
              id: toolCallId || genId(),
              name,
              args,
              thoughtSignature,
              batchId: batch?.batchId,
              batchIndex: batch?.batchIndex,
              batchSize: batch?.batchSize
            })
            // Persist periodically during long tool execution
            useChatStore.getState().persistSession(sid)
          },
          onToolEnd: (toolCallId: string, result: string) => {
            finishToolCall(agentId, toolCallId, result)
            useChatStore.getState().persistSession(sid)
          },
          onPermissionRequest: (request: any) => {
            addPermissionRequest(agentId, request)
          },
          onAskUserRequest: (request: any) => {
            addAskUserRequest(agentId, request)
          },
          onContextBudget: (snapshot: any) => {
            useChatStore.getState().setContextBudget(sid, snapshot)
          },
          onCompactionStarted: (payload: any) => {
            useChatStore.getState().setCompactionState(sid, {
              status: 'running', trigger: payload?.trigger, tokensBefore: payload?.tokensBefore
            })
          },
          onCompactionCompleted: (payload: any) => {
            useChatStore.getState().setCompactionState(sid, {
              status: 'completed', trigger: payload?.trigger,
              tokensBefore: payload?.tokensBefore, tokensAfter: payload?.tokensAfter
            })
          },
          onCompactionFailed: (payload: any) => {
            useChatStore.getState().setCompactionState(sid, {
              status: 'failed', trigger: payload?.trigger, error: payload?.message || payload?.errorCode
            })
          },
          onSubAgentStart: (subAgentId: string, meta: any) => {
            startSubAgent(agentId, subAgentId, meta)
            useChatStore.getState().persistSession(sid)
          },
          onSubAgentChunk: (subAgentId: string, delta: string, reasoningDelta: string) => {
            appendSubAgentChunk(agentId, subAgentId, delta, reasoningDelta)
          },
          onSubAgentToolStart: (subAgentId: string, toolCallId: string, name: string, args: string, thoughtSignature?: string) => {
            startSubAgentToolCall(agentId, subAgentId, {
              id: toolCallId || genId(),
              name,
              args,
              thoughtSignature
            })
          },
          onSubAgentToolEnd: (subAgentId: string, toolCallId: string, result: string) => {
            finishSubAgentToolCall(agentId, subAgentId, toolCallId, result)
          },
          onSubAgentEnd: (subAgentId: string, result: any) => {
            endSubAgent(agentId, subAgentId, result)
            useChatStore.getState().persistSession(sid)
          }
        }
      )

      firstByteTimer = setTimeout(() => {
        if (!gotFirstByte) {
          appendStreamChunk(agentId, '\n\n⚠️ 长时间未收到响应（90s），可能网络或服务异常。建议点击停止按钮后重试。')
        }
      }, 90_000)

      const wrappedCleanup = () => {
        if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null }
        useChatStore.getState().markActiveRunUserAborted(sid)
        streamHandle.stop()
        finishStreaming(agentId)
        useChatStore.getState().persistSession(sid)
        setStreamCleanup(sid, null)
      }

      setStreamCleanup(sid, wrappedCleanup)
      try {
        await streamHandle.started
      } catch (error) {
        if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null }
        streamHandle.stop()
        removeMessages([uiMessageId, agentId])
        const rollbackIds = promotedAttachments
          .filter((_item, index) => attachments[index]?.scope === 'draft')
          .map((item) => item.id)
        await window.api.attachment.rollbackPromotion(sid, rollbackIds).catch(() => undefined)
        await useChatStore.getState().persistSession(sid)
        setStreamCleanup(sid, null)
        alert(`消息发送失败：${error instanceof Error ? error.message : String(error)}`)
        return false
      }

      const draftIds = attachments
        .filter((item): item is Extract<ComposerImageAttachment, { scope: 'draft' }> => item.scope === 'draft')
        .map((item) => item.draftId)
      if (draftIds.length > 0) {
        await window.api.attachment.discardDrafts(draftIds).catch(() => undefined)
      }
      return true
    },
    [
      addUserMessage,
      startStreamingReply,
      appendStreamChunk,
      finishStreaming,
      persistCurrentSession,
      setStreamCleanup,
      createSession,
      startToolCall,
      finishToolCall,
      appendReasoningTimelineChunk,
      addPermissionRequest,
      addAskUserRequest,
      setDiffEntries,
      startSubAgent,
      appendSubAgentChunk,
      startSubAgentToolCall,
      finishSubAgentToolCall,
      endSubAgent,
      removeMessages
    ]
  )

  return { handleSendMessage }
}
