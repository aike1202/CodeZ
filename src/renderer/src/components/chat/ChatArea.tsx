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
  handleSendMessage: (message: string, modelName: string) => Promise<void>
  handleOpenRecentProject: (project: any) => Promise<void>
  setCurrentView: (view: 'home' | 'chat' | 'settings') => void
  onOpenProjectMemory?: () => void
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
  handleSendMessage,
  handleOpenRecentProject,
  setCurrentView,
  onOpenProjectMemory
}: ChatAreaProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const prevSessionIdRef = useRef<string | null>(null)

  // 智能触底滚动逻辑
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
                      {msg.txId && msg.agentStates && msg.agentStates.some((s: any) => s.type === 'edit') && (
                        <EditApprovalWidget
                          msgId={msg.id}
                          txId={msg.txId}
                          edits={msg.agentStates.filter((s: any) => s.type === 'edit').map((s: any) => {
                            const detail = s.detail || ''
                            const additions = detail.match(/\+\d+/u)?.[0] || '+0'
                            const deletions = detail.match(/-\d+/u)?.[0] || '-0'
                            return {
                              filePath: s.title.replace(/^正在编辑\s*/u, '').replace(/^已编辑\s*/u, '').trim(),
                              additions,
                              deletions
                            }
                          })}
                          editStatuses={msg.editStatuses}
                          onDiffClick={(filePath) => {
                            const tools = msg.toolCalls || (msg.executionTimeline || [])
                              .filter((t: any) => t.type === 'tool')
                              .map((t: any) => (t as any).toolCall)
                              .filter(Boolean);

                            const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
                            const targetNorm = normalize(filePath);

                            const tc = tools.find((t: any) => {
                              if (t.name !== 'write_to_file' && t.name !== 'replace_file_content' && t.name !== 'multi_replace_file_content') return false;
                              try {
                                const argsObj = JSON.parse(t.args);
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
                                const argsObj = JSON.parse(tc.args);
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
                      )}
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

      {/* 底部输入区域 */}
      <div className="w-full relative shrink-0">
        <PromptArea
          onSend={handleSendMessage}
          placeholder={activeSessionId ? "随心输入..." : "开始新的对话..."}
          onOpenProjectMemory={onOpenProjectMemory}
          onOpenSettings={() => setCurrentView('settings')}
          workspace={workspace}
        />
      </div>

      {/* 终端面板 */}
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
