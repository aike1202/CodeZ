import { useCallback } from 'react'
import { useWorkspaceStore } from '../../../stores/workspaceStore'
import { useProviderStore } from '../../../stores/providerStore'
import { useChatStore } from '../../../stores/chatStore'
import { parseSlashCommand } from '../../../commands/SlashCommandParser'

function genId(): string {
  return '_' + Math.random().toString(36).substring(2, 9)
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
  const planMode = useChatStore((s) => s.planMode)

  const handleSendMessage = useCallback(
    async (message: string, modelName: string) => {
      const ws = useWorkspaceStore.getState().workspace
      if (!ws) {
        alert('请先选择或打开一个项目工作区才能发送消息！')
        return
      }

      let allSkills: any[] = []
      try {
        allSkills = await (window as any).api.skill.getAll(ws.rootPath)
      } catch (e) {}

      // Parse slash commands to check for client-side actions before anything else
      const parseResult = parseSlashCommand(message, allSkills)
      const clientAction = parseResult.clientAction

      if (clientAction) {
        if (clientAction.type === 'plan:show-list') {
          useChatStore.getState().setPlanListModalOpen(true)
          return
        }
        if (clientAction.type === 'plan:load') {
          const slug = clientAction.payload?.slug
          if (slug) {
            try {
              await (window as any).api.plan.load(ws.rootPath, slug)
              useChatStore.getState().setExpandedCapsule('plan')
            } catch (err) {
              console.error('[useSendMessage] Failed to load plan:', err)
            }
          }
          return
        }
        if (clientAction.type === 'plan:new') {
          useChatStore.getState().togglePlanMode()
          // Send the description as a normal user message to the AI
          const description = clientAction.payload?.description || message
          if (!description) return
          // Use processedMessage from the parse result (the description text)
          message = parseResult.processedMessage || description
        }
        // For other client actions, continue normally (fall through)
        // but only if processedMessage is not empty
        if (!parseResult.processedMessage) return
      }

      const provState = useProviderStore.getState()
      const activeProv = provState.providers.find((p) => p.id === provState.activeProviderId)
      if (!activeProv) {
        const userMsg = addUserMessage(message)
        const agentId = startStreamingReply()
        const simText = `请先配置模型 Provider 才能进行 AI 对话。\n\n点击输入框左侧齿轮图标打开设置，添加一个 OpenAI-compatible Provider（如 OpenAI、Ollama、DeepSeek 等）。\n\n配置完成后，输入消息即可获得 AI 实时流式回复。`

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
        setStreamCleanup(() => () => clearInterval(interval))
        return
      }

      let sid = useChatStore.getState().activeSessionId
      if (!sid) {
        sid = createSession(ws.id)
      }

      addUserMessage(message)
      const agentId = startStreamingReply()

      const model = modelName || activeProv.models[0]?.name || 'gpt-4o'
      const currentMsgs = useChatStore.getState().messages
      const chatMessages: Array<any> = [
        {
          role: 'system',
          content: `你是一个 AI 编程助手，运行在 Codez 桌面应用中。当前项目：${ws.name}（${ws.projectType}）。请用中文回复，保持简洁专业。`
        },
        ...currentMsgs
          .filter((m) => !m.streaming)
          .flatMap((m, index, arr) => {
            const isLastMessage = index === arr.length - 1
            const mapped: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: any[]; tool_call_id?: string; name?: string; thought_signature?: string; provider_specific_fields?: any }> = []
            if (m.role === 'user') {
              let c = m.content
              if (isLastMessage) {
                const { isCommand, processedMessage } = parseSlashCommand(c, allSkills)
                if (isCommand) {
                  c = processedMessage
                } else {
                  // If not a skill command, let's look for explicitly referenced files
                  const fileRegex = /\[([^$\]][^\]]*)\]\(([^)]+)\)/g
                  const referencedFiles: string[] = []
                  let match
                  while ((match = fileRegex.exec(c)) !== null) {
                    referencedFiles.push(match[2])
                  }
                  if (referencedFiles.length > 0) {
                    c += `\n\n【系统提示：用户在本次交互中明确引用了以下工作区文件：\n${referencedFiles.map(f => `- ${f}`).join('\n')}\n如需了解其详细内容，请主动调用 read_file 工具读取。】`
                  }
                }
              }
              mapped.push({ role: 'user', content: c })
            } else {
              const assistantMsg: any = { role: 'assistant', content: m.content || '' }
              if (m.toolCalls && m.toolCalls.length > 0) {
                const finalSig = m.toolCalls[m.toolCalls.length - 1].thoughtSignature || 'skip_thought_signature_validator'
                assistantMsg.tool_calls = m.toolCalls.map((tc: any) => ({
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: tc.args },
                  thought_signature: tc.thoughtSignature || finalSig
                }))
                assistantMsg.thought_signature = finalSig
                assistantMsg.provider_specific_fields = { thought_signature: finalSig }
              }
              mapped.push(assistantMsg)
              
              if (m.toolCalls && m.toolCalls.length > 0) {
                for (const tc of m.toolCalls) {
                  if (tc.status === 'success' || tc.status === 'error') {
                    mapped.push({
                      role: 'tool',
                      tool_call_id: tc.id,
                      name: tc.name,
                      content: tc.result || ''
                    })
                  }
                }
              }
            }
            return mapped
          })
      ]

      const cleanup = (window as any).api.chat.stream(
        activeProv.id,
        model,
        chatMessages,
        sid,
        planMode,
        {
          onChunk: (delta: string, reasoningDelta?: string) => {
            appendStreamChunk(agentId, delta, reasoningDelta)
            appendReasoningTimelineChunk(agentId, reasoningDelta || '')
          },
          onDone: async (fullContent: string, _stopReason?: string, txId?: string) => {
            finishStreaming(agentId)
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
            persistCurrentSession()
            setStreamCleanup(null)
          },
          onError: (error: string) => {
            appendStreamChunk(agentId, `\n\n错误：${error}`)
            finishStreaming(agentId)
            persistCurrentSession()
            setStreamCleanup(null)
          },
          onToolStart: (toolCallId: string, name: string, args: string, thoughtSignature?: string) => {
            startToolCall(agentId, {
              id: toolCallId || genId(),
              name,
              args,
              thoughtSignature
            })
          },
          onToolEnd: (toolCallId: string, result: string) => {
            finishToolCall(agentId, toolCallId, result)
          },
          onPermissionRequest: (request: any) => {
            addPermissionRequest(agentId, request)
          },
          onAskUserRequest: (request: any) => {
            addAskUserRequest(agentId, request)
          }
        }
      )

      const wrappedCleanup = () => {
        cleanup()
        finishStreaming(agentId)
        persistCurrentSession()
        setStreamCleanup(null)
      }

      setStreamCleanup(wrappedCleanup)
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
      planMode
    ]
  )

  return { handleSendMessage }
}
