const fs = require('fs');
const path = require('path');
const tsxPath = path.resolve('src/renderer/src/components/chat/ChatArea.tsx');
let content = fs.readFileSync(tsxPath, 'utf8');

const oldImports = 'import { parseArgs } from \'../../utils/parseArgs\'';
const newImports = \import { parseArgs } from '../../utils/parseArgs'
import { parseSlashCommand } from '../../commands/SlashCommandParser'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useProviderStore } from '../../stores/providerStore'
import { useChatStore } from '../../stores/chatStore'

function genId(): string {
  return \\\\\\\\\\\_\\\\\\\\\\\;
}\;
content = content.replace(oldImports, newImports);

content = content.replace(
  /  handleSendMessage: \\(message: string, modelName: string\\) => Promise<void>\\n/, 
  ''
);

content = content.replace(
  /  handleDiffClick,\\r?\\n  handleSendMessage,\\r?\\n  handleOpenRecentProject,/,
  '  handleDiffClick,\\n  handleOpenRecentProject,'
);

const hooksStr = \  const prevSessionIdRef = useRef<string | null>(null)

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

  const handleSendMessage = React.useCallback(
    async (message: string, modelName: string) => {
      const ws = useWorkspaceStore.getState().workspace
      if (!ws) {
        alert('请先选择或打开一个项目工作区才能发送消息！')
        return
      }

      const provState = useProviderStore.getState()
      const activeProv = provState.providers.find((p) => p.id === provState.activeProviderId)
      if (!activeProv) {
        const userMsg = addUserMessage(message)
        const agentId = startStreamingReply()
        const simText = \\\\\请先配置模型 Provider 才能进行 AI 对话。\\\\n\\\\n点击输入框左侧齿轮图标打开设置，添加一个 OpenAI-compatible Provider（如 OpenAI、Ollama、DeepSeek 等）。\\\\n\\\\n配置完成后，输入消息即可获得 AI 实时流式回复。\\\\\

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

      let allSkills: any[] = []
      try {
        allSkills = await (window as any).api.skill.getAll(ws.rootPath)
      } catch (e) {}

      const model = modelName || activeProv.models[0]?.name || 'gpt-4o'
      const currentMsgs = useChatStore.getState().messages
      const chatMessages: Array<any> = [
        {
          role: 'system',
          content: \\\\\你是一个 AI 编程助手，运行在 Codez 桌面应用中。当前项目：\\\\\\（\\\\\\）。请用中文回复，保持简洁专业。\\\\\
        },
        ...currentMsgs
          .filter((m) => !m.streaming)
          .slice(-40)
          .flatMap((m, index, arr) => {
            const isLastMessage = index === arr.length - 1
            const mapped: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: any[]; tool_call_id?: string; name?: string; thought_signature?: string; provider_specific_fields?: any }> = []
            if (m.role === 'user') {
              let c = m.content
              if (isLastMessage) {
                const { isCommand, processedMessage } = parseSlashCommand(c, allSkills)
                if (isCommand) {
                  c = processedMessage
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
        {
          onChunk: (delta: string, reasoningDelta?: string) => {
            appendStreamChunk(agentId, delta, reasoningDelta)
            appendReasoningTimelineChunk(agentId, reasoningDelta || '')
          },
          onDone: (fullContent: string, txId?: string) => {
            finishStreaming(agentId)
            if (txId) {
              useChatStore.getState().setTransactionId(agentId, txId)
            }
            persistCurrentSession()
            setStreamCleanup(null)
          },
          onError: (error: string) => {
            appendStreamChunk(agentId, \\\\\\\\\n\\\\n错误：\\\\\\\\\\\)
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
    [addUserMessage, startStreamingReply, appendStreamChunk, finishStreaming, persistCurrentSession, setStreamCleanup, createSession, startToolCall, finishToolCall, appendReasoningTimelineChunk]
  )\;

content = content.replace(
  '  const prevSessionIdRef = useRef<string | null>(null)',
  hooksStr
);

fs.writeFileSync(tsxPath, content);
console.log('ChatArea.tsx patched');

