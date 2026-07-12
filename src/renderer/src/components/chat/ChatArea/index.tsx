import React, { useEffect, useRef, useMemo, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WorkspaceInfo } from '@shared/types/workspace'
import type { PermissionApprovalResponse } from '@shared/types/permission'
import HomePage from '../../../pages/HomePage'
import PromptArea from '../../PromptArea'
import EditApprovalWidget from '../EditApprovalWidget'
import PermissionApprovalWidget from '../PermissionApprovalWidget'
import AskUserQuestionWidget from '../AskUserQuestionWidget'
import TerminalPanel from '../TerminalPanel'
import { ChatAreaLayout } from '../ChatAreaLayout'
import { parseArgs } from '../../../utils/parseArgs'
import { computeEditStats, handleDiffClickForFile } from '../../../utils/editDiffUtils'
import { useChatStore, type ChatMessage } from '../../../stores/chatStore'
import { useSendMessage } from '../hooks/useSendMessage'
import { ChatMessageList } from './components/ChatMessageList'
import ConversationNavigator from '../ConversationNavigator'

/** 距底部小于视口高度的此比例算"在底部" */
const SCROLL_BOTTOM_RATIO = 0.15
/** "在底部"阈值的最小像素值(小视口保护) */
const SCROLL_BOTTOM_MIN_PX = 100
const EMPTY_QUEUED_PROMPTS: never[] = []

function isNearBottom(container: HTMLElement): boolean {
  const distance = container.scrollHeight - container.scrollTop - container.clientHeight
  return distance < Math.max(container.clientHeight * SCROLL_BOTTOM_RATIO, SCROLL_BOTTOM_MIN_PX)
}

export function extractMessageEdits(msg: ChatMessage) {
  if (!msg.txId) return { edits: [], tools: [] }

  const tools = msg.toolCalls || (msg.executionTimeline || [])
    .filter((t: any) => t.type === 'tool')
    .map((t: any) => (t as any).toolCall)
    .filter(Boolean)

  const editTools = tools.filter((tc: any) =>
    ['Edit', 'Write', 'NotebookEdit'].includes(tc.name)
  )

  if (editTools.length === 0) return { edits: [], tools: [] }

  let diffByPath: Record<string, string> = {}
  try {
    diffByPath = (msg.diffEntries || []).reduce((acc: Record<string, string>, item: any) => {
      if (item?.path && item?.diff) acc[item.path] = item.diff
      return acc
    }, {})
  } catch {
    diffByPath = {}
  }

  const edits = editTools
    .map((tc: any) => {
      let filePath = ''
      let additions = '+0'
      let deletions = '-0'
      try {
        const argsObj = parseArgs(tc.args)
        filePath =
          argsObj.file_path ||
          argsObj.targetFile ||
          argsObj.TargetFile ||
          argsObj.filePath ||
          argsObj.path ||
          ''

        const matchingDiff = Object.entries(diffByPath).find(([diffPath]) => {
          if (!filePath) return false
          const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase()
          const fileNorm = normalize(filePath)
          const diffNorm = normalize(diffPath)
          return fileNorm === diffNorm || diffNorm.endsWith(fileNorm) || fileNorm.endsWith(diffNorm)
        })?.[1]

        if (matchingDiff) {
          const added = matchingDiff
            .split('\n')
            .filter((line) => line.startsWith('+') && !line.startsWith('+++')).length
          const removed = matchingDiff
            .split('\n')
            .filter((line) => line.startsWith('-') && !line.startsWith('---')).length
          additions = `+${added}`
          deletions = `-${removed}`
        } else {
          const stats = computeEditStats(tc.name, tc.args)
          additions = stats.additions
          deletions = stats.deletions
        }
      } catch (err) {
        console.error('Failed to parse edit args in ChatArea:', err)
      }
      return { filePath, additions, deletions }
    })
    .filter((e: any) => e.filePath)

  return { edits, tools }
}

export { handleDiffClickForFile as handleApprovalDiffClick }

export interface ChatAreaProps {
  messages: ChatMessage[]
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
  onOpenSettings: (tab?: string) => void
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
  onOpenSettings
}: ChatAreaProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const prevSessionIdRef = useRef<string | null>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const [isFollowing, setIsFollowing] = useState(true)
  const [containerMounted, setContainerMounted] = useState(false)

  // containerRef.current 存在后才渲染 portal 按钮
  useEffect(() => {
    if (containerRef.current) {
      setContainerMounted(true)
    }
  }, [])

  const scrollToBottom = useCallback(() => {
    const container = containerRef.current
    if (!container || scrollFrameRef.current !== null) return
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null
      container.scrollTop = container.scrollHeight
    })
  }, [])

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current)
    }
  }, [])

  const handleScroll = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    setIsFollowing(isNearBottom(container))
  }, [])

  // We no longer need handleWheel or handleTouchStart to break following,
  // because handleScroll accurately reflects the current position.

  const resolvePermissionRequest = useChatStore((s) => s.resolvePermissionRequest)
  const resolveAskUserRequest = useChatStore((s) => s.resolveAskUserRequest)
  const pendingInternalContinuation = useChatStore((s) => s.pendingInternalContinuation)
  const consumeInternalContinuation = useChatStore((s) => s.consumeInternalContinuation)
  const streamCleanups = useChatStore((s) => s.streamCleanups)
  const queuedPrompts = useChatStore((s) => {
    if (!s.activeSessionId) return EMPTY_QUEUED_PROMPTS
    return s.sessions.find((session) => session.id === s.activeSessionId)?.queuedPrompts || EMPTY_QUEUED_PROMPTS
  })
  const activeRuntimeStatus = useChatStore((s) => s.activeSessionId
    ? s.runtimeStatuses[s.activeSessionId]?.status
    : undefined)
  const updateQueuedPrompt = useChatStore((s) => s.updateQueuedPrompt)
  const removeQueuedPrompt = useChatStore((s) => s.removeQueuedPrompt)
  const { handleSendMessage } = useSendMessage()
  const queuedDispatchRef = useRef<string | null>(null)

  useEffect(() => {
    if (!activeSessionId || !pendingInternalContinuation) return
    if (pendingInternalContinuation.sessionId !== activeSessionId) return
    if (streamCleanups[activeSessionId]) return
    const targetSession = useChatStore.getState().sessions.find(
      (session) => session.id === activeSessionId
    )
    if (!workspace || targetSession?.projectId !== workspace.id) return

    const continuation = consumeInternalContinuation(activeSessionId)
    if (!continuation) return
    void handleSendMessage(continuation.text, '', true, [], { visibility: 'internal' })
  }, [
    activeSessionId,
    pendingInternalContinuation,
    streamCleanups,
    consumeInternalContinuation,
    handleSendMessage,
    workspace
  ])

  useEffect(() => {
    if (!activeSessionId || pendingInternalContinuation || queuedPrompts.length === 0) return
    if (streamCleanups[activeSessionId]) return
    if (activeRuntimeStatus?.mainRunnerActive || activeRuntimeStatus?.activeSubAgentIds.length) return
    const prompt = queuedPrompts[0]
    if (prompt.status === 'failed') return
    if (queuedDispatchRef.current) return

    queuedDispatchRef.current = prompt.id
    updateQueuedPrompt(activeSessionId, prompt.id, { status: 'steering' })
    void handleSendMessage(prompt.text, prompt.modelName, false, prompt.attachments)
      .then((accepted) => {
        if (accepted) removeQueuedPrompt(activeSessionId, prompt.id)
        else updateQueuedPrompt(activeSessionId, prompt.id, { status: 'failed' })
      })
      .finally(() => {
        if (queuedDispatchRef.current === prompt.id) queuedDispatchRef.current = null
      })
  }, [
    activeRuntimeStatus,
    activeSessionId,
    handleSendMessage,
    pendingInternalContinuation,
    queuedPrompts,
    removeQueuedPrompt,
    streamCleanups,
    updateQueuedPrompt
  ])

  const handleResolvePermission = useCallback(
    async (msgId: string, requestId: string, response: PermissionApprovalResponse) => {
      try {
        await window.api.chat.respondToApproval(requestId, response)
      } catch (error) {
        console.warn('Failed to send approval response to backend:', error)
      } finally {
        resolvePermissionRequest(msgId, requestId, response)
      }
    },
    [resolvePermissionRequest]
  )

  const handleResolveAskUser = useCallback(
    async (
      msgId: string,
      requestId: string,
      answers: Array<{ question: string; answer: string | string[] }>
    ) => {
      try {
        await window.api.chat.respondAskUser(requestId, answers)
      } catch (error) {
        console.warn('Failed to send ask-user response to backend:', error)
      } finally {
        resolveAskUserRequest(msgId, requestId, answers)
      }
    },
    [resolveAskUserRequest]
  )

  // Listen for activeSessionId change to force scroll
  useEffect(() => {
    if (messages.length === 0) return

    const lastMsg = messages[messages.length - 1]
    const isUserLast = lastMsg?.role === 'user'
    const isSessionChanged = prevSessionIdRef.current !== activeSessionId
    prevSessionIdRef.current = activeSessionId

    if (isUserLast || isSessionChanged) {
      setIsFollowing(true)
      scrollToBottom()
    }
  }, [messages, activeSessionId, scrollToBottom])

  // Observe content height changes
  useEffect(() => {
    const content = contentRef.current
    if (!content) return

    const observer = new ResizeObserver(() => {
      if (isFollowing) {
        scrollToBottom()
      }
    })
    
    observer.observe(content)
    return () => observer.disconnect()
  }, [isFollowing, scrollToBottom])

  const hasMessages = messages.length > 0

  const lastStreamingMsgId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'agent' && messages[i].streaming) {
        return messages[i].id
      }
    }
    return null
  }, [messages])

  const auditMessages = useMemo(() => {
    return messages.filter((m) => {
      const hasPendingPermission = m.permissionRequests?.some((r: any) => r.status === 'pending')
      const hasPendingAskUser = m.askUserRequests?.some((r: any) => r.status === 'pending')
      const { edits } = extractMessageEdits(m)
      const hasPendingEdits = edits.length > 0 && !edits.every((e: any) => m.editStatuses?.[e.filePath])
      return hasPendingPermission || hasPendingAskUser || hasPendingEdits
    })
  }, [messages])

  const scrollToBottomButton =
    <button
      type="button"
      className={`scroll-to-bottom-btn ${!isFollowing && hasMessages ? 'visible' : ''}`}
      onClick={() => {
        setIsFollowing(true)
        scrollToBottom()
      }}
      aria-label="回到最新"
    >
      ↓ 回到最新
    </button>

  return (
    <>
      <ChatAreaLayout
        scrollToBottomButton={scrollToBottomButton}
        containerRef={containerRef}
        panelOpen={panelOpen}
        onScroll={handleScroll}
        navigationRail={
          hasMessages ? (
            <ConversationNavigator
              messages={messages}
              containerRef={containerRef}
              contentRef={contentRef}
            />
          ) : undefined
        }
        messageArea={
          hasMessages ? (
            <div ref={contentRef} style={{ width: '100%', flexShrink: 0 }}>
              <ChatMessageList
                messages={messages}
                lastStreamingMsgId={lastStreamingMsgId}
                handleFileClick={handleFileClick}
                handleDiffClick={handleDiffClick}
              />
            </div>
          ) : (
            <HomePage onOpenRecentProject={handleOpenRecentProject} />
          )
        }
      auditArea={
        auditMessages.length > 0 ? (
          <div style={{ width: '100%', flexShrink: 0, zIndex: 60, marginBottom: '-16px' }}>
            {auditMessages.map((msg) => {
              const { edits, tools } = extractMessageEdits(msg)
              const hasPendingEdits =
                edits.length > 0 && !edits.every((e: any) => msg.editStatuses?.[e.filePath])
              const pendingPermissions = msg.permissionRequests?.filter((r: any) => r.status === 'pending') || []
              const hasPendingPermission = pendingPermissions.length > 0
              const pendingAskUser = msg.askUserRequests?.filter((r: any) => r.status === 'pending') || []
              const hasPendingAskUser = pendingAskUser.length > 0

              if (!hasPendingPermission && !hasPendingEdits && !hasPendingAskUser) return null

              return (
                <div
                  key={msg.id}
                  style={{
                    width: '100%',
                    maxWidth: '48rem',
                    margin: '0 auto',
                    padding: '0 16px',
                    marginBottom: '8px',
                    pointerEvents: 'auto'
                  }}
                >
                  {hasPendingPermission && (
                    <div className="dropdown-shadow rounded-xl mb-2">
                      <PermissionApprovalWidget
                        msgId={msg.id}
                        requests={pendingPermissions}
                        onResolve={handleResolvePermission}
                      />
                    </div>
                  )}
                  {(() => {
                    const pendingAsk = msg.askUserRequests?.filter((r: any) => r.status === 'pending') || []
                    if (pendingAsk.length === 0) return null
                    return (
                      <div className="dropdown-shadow rounded-xl mb-2">
                        <AskUserQuestionWidget
                          msgId={msg.id}
                          requests={pendingAsk}
                          onResolve={handleResolveAskUser}
                        />
                      </div>
                    )
                  })()}
                  {hasPendingEdits && (
                    <div className="dropdown-shadow rounded-xl">
                      <EditApprovalWidget
                        msgId={msg.id}
                        txId={msg.txId || ''}
                        edits={edits}
                        editStatuses={msg.editStatuses}
                        onDiffClick={(filePath) =>
                          handleDiffClickForFile(filePath, tools, handleDiffClick, handleFileClick)
                        }
                        onFileClick={(filePath) => handleFileClick(filePath)}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : undefined
      }
      promptArea={
        <div style={{ width: '100%', flexShrink: 0, zIndex: 50 }}>
          <PromptArea
            onSend={(message, modelName, attachments) =>
              handleSendMessage(message, modelName, false, attachments)}
            onSteer={async (prompt) => {
              if (!activeSessionId) return false
              const result = await window.api.chat.steer(activeSessionId, {
                queueId: prompt.id,
                text: prompt.text,
                attachments: prompt.attachments.filter((attachment) => attachment.scope === 'session')
              })
              return result.accepted
            }}
            placeholder={activeSessionId ? '随心输入...' : '开始新的对话...'}
            onOpenSettings={() => onOpenSettings('model-config')}
            workspace={workspace}
          />
        </div>
      }
      terminalPanel={
        terminalOpen && workspace ? (
          <TerminalPanel
            workspaceId={workspace.id}
            rootPath={workspace.rootPath}
            height={terminalHeight}
            setHeight={setTerminalHeight}
            onClose={() => setTerminalOpen(false)}
            sidebarWidth={sidebarWidth}
            previewPanelWidth={previewPanelWidth}
          />
        ) : undefined
      }
      />
    </>
  )
}
