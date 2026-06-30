import React, { useEffect, useRef, useMemo } from 'react'
import type { WorkspaceInfo } from '@shared/types/workspace'
import HomePage from '../../pages/HomePage'
import PromptArea from '../PromptArea'
import ExecutionLog from './ExecutionLog'
import MessageBody from './MessageBody'
import EditApprovalWidget from './EditApprovalWidget'
import PermissionApprovalWidget from './PermissionApprovalWidget'
import TerminalPanel from './TerminalPanel'
import Flex from '../ui/Flex'
import Stack from '../ui/Stack'
import { ChatAreaLayout } from './ChatAreaLayout'
import { parseArgs } from '../../utils/parseArgs'
import { computeEditStats, handleDiffClickForFile } from '../../utils/editDiffUtils'
import { parseSlashCommand } from '../../commands/SlashCommandParser'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useProviderStore } from '../../stores/providerStore'
import { useChatStore } from '../../stores/chatStore'

import { AgentMessageContent } from './AgentMessageContent'
import { useSendMessage } from './hooks/useSendMessage'
import IconBot from '../icons/IconBot'

function genId(): string {
  return '_' + Math.random().toString(36).substring(2, 9)
}

export function extractMessageEdits(msg: any) {
  if (!msg.txId) return { edits: [], tools: [] };

  const tools = msg.toolCalls || (msg.executionTimeline || [])
    .filter((t: any) => t.type === 'tool')
    .map((t: any) => (t as any).toolCall)
    .filter(Boolean);

  const editTools = tools.filter((tc: any) =>
    tc.name === 'write_to_file' ||
    tc.name === 'replace_file_content' ||
    tc.name === 'multi_replace_file_content' ||
    tc.name === 'apply_patch'
  );

  if (editTools.length === 0) return { edits: [], tools: [] };

  let diffByPath: Record<string, string> = {};
  try {
    diffByPath = (msg.diffEntries || []).reduce((acc: Record<string, string>, item: any) => {
      if (item?.path && item?.diff) acc[item.path] = item.diff;
      return acc;
    }, {});
  } catch {
    diffByPath = {};
  }

  const edits = editTools.map((tc: any) => {
    let filePath = '';
    let additions = '+0';
    let deletions = '-0';
    try {
      const argsObj = parseArgs(tc.args);
      filePath = argsObj.targetFile || argsObj.TargetFile || argsObj.filePath || argsObj.path || '';

      const matchingDiff = Object.entries(diffByPath).find(([diffPath]) => {
        if (!filePath) return false;
        const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
        const fileNorm = normalize(filePath);
        const diffNorm = normalize(diffPath);
        return fileNorm === diffNorm || diffNorm.endsWith(fileNorm) || fileNorm.endsWith(diffNorm);
      })?.[1];

      if (matchingDiff) {
        const added = matchingDiff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
        const removed = matchingDiff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
        additions = `+${added}`;
        deletions = `-${removed}`;
      } else {
        const stats = computeEditStats(tc.name, tc.args);
        additions = stats.additions;
        deletions = stats.deletions;
      }
    } catch (err) {
      console.error('Failed to parse edit args in ChatArea:', err);
    }
    return { filePath, additions, deletions };
  }).filter((e: any) => e.filePath);

  return { edits, tools };
}

export { handleDiffClickForFile as handleApprovalDiffClick }

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
  const prevSessionIdRef = useRef<string | null>(null)

  const resolvePermissionRequest = useChatStore((s) => s.resolvePermissionRequest)
  const { handleSendMessage } = useSendMessage()

  const handleResolvePermission = React.useCallback(async (msgId: string, requestId: string, approved: boolean) => {
    try {
      await window.api.chat.respondToApproval(requestId, approved)
    } catch (error) {
      console.warn('Failed to send approval response to backend (handler may be expired):', error)
    } finally {
      resolvePermissionRequest(msgId, requestId, approved)
    }
  }, [resolvePermissionRequest])

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

  // P0 优化: 提前计算 lastStreamingMsgId，避免在 map 内 O(N²) 重复计算
  const lastStreamingMsgId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'agent' && messages[i].streaming) {
        return messages[i].id
      }
    }
    return null
  }, [messages])

  // P0 优化: 缓存需要审批的消息列表，避免 auditArea 重复调用 extractMessageEdits
  const auditMessages = useMemo(() => {
    return messages.filter(m => {
      const hasPendingPermission = m.permissionRequests?.some((r: any) => r.status === 'pending')
      const { edits } = extractMessageEdits(m)
      const hasPendingEdits = edits.length > 0 && !edits.every((e: any) => m.editStatuses?.[e.filePath])
      return hasPendingPermission || hasPendingEdits
    })
  }, [messages])

  return (
    <ChatAreaLayout
      containerRef={containerRef}
      panelOpen={panelOpen}
      messageArea={
        hasMessages ? (
          <Stack gap={6} className="app-message-list">
            {messages.map((msg) => {
              return msg.role === 'user' ? (
                <Flex key={msg.id} justify="end" className="w-full">
                  <div className="user-message-bubble">
                    <MessageBody content={msg.content} onFileClick={handleFileClick} />
                  </div>
                </Flex>
              ) : (
                <Flex key={msg.id} justify="start" className="w-full max-w-3xl">
                  <Flex align="center" justify="center" className="agent-avatar">
                    <IconBot width={18} height={18} />
                  </Flex>
                  <AgentMessageContent
                    msg={msg}
                    lastStreamingMsgId={lastStreamingMsgId}
                    handleFileClick={handleFileClick}
                    handleDiffClick={handleDiffClick}
                  />
                </Flex>
              )
            })}
          </Stack>
        ) : (
          <HomePage onOpenRecentProject={handleOpenRecentProject} />
        )
      }
      auditArea={
        auditMessages.length > 0 ? (
          <div style={{ width: '100%', flexShrink: 0, zIndex: 60, marginBottom: '-16px' }}>
            {auditMessages.map((msg) => {
              const { edits, tools } = extractMessageEdits(msg);
              const hasPendingEdits = edits.length > 0 && !edits.every((e: any) => msg.editStatuses?.[e.filePath]);
              const pendingPermissions = msg.permissionRequests?.filter((r: any) => r.status === 'pending') || [];
              const hasPendingPermission = pendingPermissions.length > 0;

              if (!hasPendingPermission && !hasPendingEdits) return null;

              return (
                <div key={msg.id} style={{ width: '100%', maxWidth: '48rem', margin: '0 auto', padding: '0 16px', marginBottom: '8px', pointerEvents: 'auto' }}>
                  {hasPendingPermission && (
                    <div className="dropdown-shadow rounded-xl mb-2">
                      <PermissionApprovalWidget
                        msgId={msg.id}
                        requests={pendingPermissions}
                        onResolve={handleResolvePermission}
                      />
                    </div>
                  )}
                  {hasPendingEdits && (
                    <div className="dropdown-shadow rounded-xl">
                      <EditApprovalWidget
                        msgId={msg.id}
                        txId={msg.txId}
                        edits={edits}
                        editStatuses={msg.editStatuses}
                        onDiffClick={(filePath) => handleDiffClickForFile(filePath, tools, handleDiffClick, handleFileClick)}
                        onFileClick={(filePath) => handleFileClick(filePath)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : undefined
      }
      promptArea={
        <div style={{ width: '100%', flexShrink: 0, zIndex: 50 }}>
          <PromptArea
            onSend={handleSendMessage}
            placeholder={activeSessionId ? "随心输入..." : "开始新的对话..."}
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
  )
}

