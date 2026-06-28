import React, { useEffect, useRef } from 'react'
import type { WorkspaceInfo } from '@shared/types/workspace'
import HomePage from '../../pages/HomePage'
import PromptArea from '../PromptArea'
import ExecutionLog from './ExecutionLog'
import MessageBody from './MessageBody'
import EditApprovalWidget from './EditApprovalWidget'
import TerminalPanel from './TerminalPanel'
import Flex from '../ui/Flex'
import Stack from '../ui/Stack'
import { parseArgs } from '../../utils/parseArgs'
import { parseSlashCommand } from '../../commands/SlashCommandParser'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useProviderStore } from '../../stores/providerStore'
import { useChatStore } from '../../stores/chatStore'

function genId(): string {
  return `_`
}

export interface ChatAreaProps {
  messages: any[]
  activeSessionId: string | null
  workspace: WorkspaceInfo | null
  terminalOpen: boolean
  setTerminalOpen: (open: boolean) => void
  terminalHeight: number
  setTerminalHeight: (height: number) => void
  sidebarWidth: number
  previewPanelWidth: number
  panelOpen: boolean
  handleFileClick: (filePath: string, virtualContent?: string) => Promise<void>
  handleDiffClick: (
    filePath: string,
    editInfo: {
      type: 'write' | 'replace'
      targetContent?: string
      replacementContent?: string
      codeContent?: string
    }
  ) => void
  handleOpenRecentProject: (project: any) => Promise<void>
  setCurrentView: (view: 'home' | 'chat' | 'settings') => void
}

export default function ChatArea({
  messages,
  activeSessionId,
  workspace,
  terminalOpen,
  setTerminalOpen,
  terminalHeight,
  setTerminalHeight,
  sidebarWidth,
  previewPanelWidth,
  panelOpen,
  handleFileClick,
  handleDiffClick,
  handleOpenRecentProject,
  setCurrentView
}: ChatAreaProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const prevSessionIdRef = useRef<string | null>(null)

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

      let allSkills: any[] = []
      try {
        allSkills = await (window as any).api.skill.getAll(ws.rootPath)
      } catch (e) {}

      const model = modelName || activeProv.models[0]?.name || 'gpt-4o'
      const currentMsgs = useChatStore.getState().messages
      const chatMessages: Array<any> = [
        {
          role: 'system',
          content: `你是一个 AI 编程助手，运行在 Codez 桌面应用中。当前项目：{ws.name}（{ws.projectType}）。请用中文回复，保持简洁专业。`
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
            appendStreamChunk(agentId, `\n\n错误：{error}`)
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
  )

  // 鏅鸿兘瑙﹀簳婊氬姩閫昏緫
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const lastMsg = messages[messages.length - 1]
    const isUserLast = lastMsg?.role === 'user'
    const isSessionChanged = prevSessionIdRef.current !== activeSessionId
    prevSessionIdRef.current = activeSessionId

    const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150

    if (isUserLast || isSessionChanged || isAtBottom) {
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight
      })
    }
  }, [messages, activeSessionId])

  const hasMessages = messages.length > 0

  return (
    <Stack className={`app-chat-column ${panelOpen ? 'app-chat-column--border' : ''}`}>
      <Stack ref={containerRef} align="center" className="app-chat-scroll-area">
        {(() => {
          const lastStreamingMsgId = messages.reduceRight<string | null>((acc, m) => {
            if (acc) return acc
            if (m.role === 'agent' && m.streaming) return m.id
            return null
          }, null)

          return hasMessages ? (
            <Stack gap={6} className="app-message-list">
              {messages.map((msg) =>
                msg.role === 'user' ? (
                  <Flex key={msg.id} justify="end" className="w-full">
                    <div className="user-message-bubble">
                      <MessageBody content={msg.content} onFileClick={handleFileClick} />
                    </div>
                  </Flex>
                ) : (
                  <Flex key={msg.id} justify="start" className="w-full max-w-3xl">
                    <Flex align="center" justify="center" className="agent-avatar">
                      AI
                    </Flex>
                    <div className="agent-message-content">
                      {(() => {
                        if (!msg.executionTimeline || msg.executionTimeline.length === 0) {
                          return (
                            <>
                              <ExecutionLog timeline={[]} reasoning={msg.reasoningContent} agentStates={msg.agentStates} onFileClick={handleFileClick} onDiffClick={handleDiffClick} streaming={msg.streaming && msg.id === lastStreamingMsgId} />
                              <MessageBody content={msg.content} streaming={msg.streaming && msg.id === lastStreamingMsgId} reasoning={msg.reasoningContent} onFileClick={handleFileClick} />
                            </>
                          )
                        }

                        const executionTimeline = msg.executionTimeline || []

                        // Find the last non-text node (i.e. last tool call)
                        let lastNonTextIdx = -1
                        for (let i = executionTimeline.length - 1; i >= 0; i--) {
                          if (executionTimeline[i].type !== 'text') {
                            lastNonTextIdx = i
                            break
                          }
                        }

                        const isStreaming = msg.streaming && msg.id === lastStreamingMsgId;
                        let timelineForLog: any[] = [];
                        let finalContent = '';

                        if (isStreaming) {
                          timelineForLog = executionTimeline;
                          finalContent = '';
                        } else {
                          timelineForLog = lastNonTextIdx === -1 ? [] : executionTimeline.slice(0, lastNonTextIdx + 1);
                           timelineForLog = timelineForLog.filter((item: any) => item.type !== 'text');

                           const finalTextItems = lastNonTextIdx === -1 ? executionTimeline : executionTimeline.slice(lastNonTextIdx + 1);
                           finalContent = finalTextItems
                             .filter((item: any) => item.type === 'text')
                             .map((item: any) => (item as any).content)
                             .join('')
                             .trimStart();
                         }

                        const hasToolsOrAgentStates = timelineForLog.length > 0 || (msg.agentStates && msg.agentStates.length > 0) || !!msg.reasoningContent

                        return (
                          <>
                            {hasToolsOrAgentStates && (
                              <div className="app-spacer">
                                <ExecutionLog
                                  timeline={timelineForLog}
                                  reasoning={msg.reasoningContent}
                                  agentStates={msg.agentStates}
                                  onFileClick={handleFileClick}
                                  onDiffClick={handleDiffClick}
                                  streaming={isStreaming && !finalContent}
                                />
                              </div>
                            )}
                            {finalContent && (
                              <div className={hasToolsOrAgentStates ? "mt-4" : ""}>
                                <MessageBody
                                  content={finalContent}
                                  streaming={false}
                                  onFileClick={handleFileClick}
                                />
                              </div>
                            )}
                          </>
                        )
                      })()}
                      {(() => {
                        if (!msg.txId) return null;

                        const tools = msg.toolCalls || (msg.executionTimeline || [])
                          .filter((t: any) => t.type === 'tool')
                          .map((t: any) => (t as any).toolCall)
                          .filter(Boolean);

                        const editTools = tools.filter((tc: any) =>
                          tc.name === 'write_to_file' ||
                          tc.name === 'replace_file_content' ||
                          tc.name === 'multi_replace_file_content'
                        );

                        if (editTools.length === 0) return null;

                        const edits = editTools.map((tc: any) => {
                          let filePath = '';
                          let additions = '+0';
                          let deletions = '-0';
                          try {
                            const argsObj = parseArgs(tc.args);
                            filePath = argsObj.targetFile || argsObj.TargetFile || argsObj.filePath || argsObj.path || '';

                            if (tc.name === 'write_to_file') {
                              const codeContent = argsObj.codeContent || argsObj.code_content || '';
                              additions = `+${codeContent.split('\n').length}`;
                            } else if (tc.name === 'replace_file_content') {
                              additions = `+${(argsObj.replacementContent || '').split('\n').length}`;
                              deletions = `-${(argsObj.targetContent || '').split('\n').length}`;
                            } else if (tc.name === 'multi_replace_file_content') {
                              const chunks = Array.isArray(argsObj.ReplacementChunks) ? argsObj.ReplacementChunks : (Array.isArray(argsObj.replacementChunks) ? argsObj.replacementChunks : []);
                              let totalAdds = 0;
                              let totalDels = 0;
                              chunks.forEach((chunk: any) => {
                                const add = chunk.ReplacementContent || chunk.replacementContent || '';
                                const del = chunk.TargetContent || chunk.targetContent || '';
                                totalAdds += add.split('\n').length;
                                totalDels += del.split('\n').length;
                              });
                              additions = `+${totalAdds}`;
                              deletions = `-${totalDels}`;
                            }
                          } catch (err) {
                            console.error('Failed to parse edit args in ChatArea:', err);
                          }
                          return { filePath, additions, deletions };
                        }).filter((e: any) => e.filePath);

                        if (edits.length === 0) return null;

                        return (
                          <EditApprovalWidget
                            msgId={msg.id}
                            txId={msg.txId}
                            edits={edits}
                            editStatuses={msg.editStatuses}
                            onDiffClick={(filePath) => {
                              const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
                              const targetNorm = normalize(filePath);
                              const tc = tools.find((t: any) => {
                                if (t.name !== 'write_to_file' && t.name !== 'replace_file_content' && t.name !== 'multi_replace_file_content') return false;
                                try {
                                  const argsObj = parseArgs(t.args);
                                  const fileArg = argsObj.targetFile || argsObj.TargetFile || argsObj.filePath || argsObj.path;
                                  if (typeof fileArg === 'string') {
                                    const fileNorm = normalize(fileArg);
                                    return fileNorm === targetNorm || targetNorm.endsWith(fileNorm) || fileNorm.endsWith(targetNorm);
                                  }
                                } catch {
                                  // ignore
                                }
                                return false;
                              });

                              if (tc) {
                                try {
                                  const argsObj = parseArgs(tc.args);
                                  if (tc.name === 'write_to_file') {
                                    handleDiffClick(filePath, {
                                      type: 'write',
                                      codeContent: argsObj.codeContent || argsObj.code_content || ''
                                    });
                                  } else if (tc.name === 'replace_file_content') {
                                    handleDiffClick(filePath, {
                                      type: 'replace',
                                      targetContent: argsObj.targetContent || '',
                                      replacementContent: argsObj.replacementContent || ''
                                    });
                                  } else if (tc.name === 'multi_replace_file_content') {
                                    const chunks = Array.isArray(argsObj.ReplacementChunks) ? argsObj.ReplacementChunks : (Array.isArray(argsObj.replacementChunks) ? argsObj.replacementChunks : []);
                                    const targetContent = chunks.map((c: any, i: number) => `--- Chunk ${i + 1} ---\n${c.TargetContent || c.targetContent || ''}`).join('\n\n');
                                    const replacementContent = chunks.map((c: any, i: number) => `--- Chunk ${i + 1} ---\n${c.ReplacementContent || c.replacementContent || ''}`).join('\n\n');
                                    handleDiffClick(filePath, {
                                      type: 'replace',
                                      targetContent,
                                      replacementContent
                                    });
                                  }
                                } catch (err) {
                                  console.error('Failed to parse diff args from toolCall:', err);
                                  handleFileClick(filePath);
                                }
                              } else {
                                handleFileClick(filePath);
                              }
                            }}
                          />
                        );
                      })()}
                    </div>
                  </Flex>
                )
              )}
            </Stack>
          ) : (
            <HomePage onOpenRecentProject={handleOpenRecentProject} />
          )
        })()}
      </Stack>

      {/* 搴曢儴杈撳叆鍖哄煙 */}
      <div className="w-full relative shrink-0">
        <PromptArea
          onSend={handleSendMessage}
          placeholder={activeSessionId ? "闅忓績杈撳叆..." : "寮€濮嬫柊鐨勫璇?.."}
          onOpenSettings={() => setCurrentView('settings')}
          workspace={workspace}
        />
      </div>

      {/* 缁堢闈㈡澘 */}
      {terminalOpen && workspace && (
        <TerminalPanel
          workspaceId={workspace.id}
          rootPath={workspace.rootPath}
          height={terminalHeight}
          setHeight={setTerminalHeight}
          onClose={() => setTerminalOpen(false)}
          sidebarWidth={sidebarWidth}
          previewPanelWidth={previewPanelWidth}
        />
      )}
    </Stack>
  )
}

