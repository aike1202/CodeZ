import React from 'react'
import { IconMessage as Message, IconArchive as Archive, IconUnarchive as Unarchive, IconTrash as Trash, IconCheck as Check, IconClose as Close } from '../../Icons'
import Button from '../../ui/Button'
import Flex from '../../ui/Flex'
import type { SidebarSession } from '../types'

interface SessionItemProps {
  session: SidebarSession
  isActiveSession: boolean
  confirmState: { sessionId: string; action: 'archive' | 'unarchive' | 'delete' | 'restore' | 'forceDelete' } | null
  setConfirmState: (state: { sessionId: string; action: 'archive' | 'unarchive' | 'delete' | 'restore' | 'forceDelete' } | null) => void
  onSelectSession: (sessionId: string) => void
  onArchiveSession?: (sessionId: string, archive: boolean) => void
  onDeleteSession?: (sessionId: string) => void
  isArchivedOrDeleted?: boolean
}

export default function SessionItem({
  session,
  isActiveSession,
  confirmState,
  setConfirmState,
  onSelectSession,
  onArchiveSession,
  onDeleteSession,
  isArchivedOrDeleted = false
}: SessionItemProps): React.ReactElement {
  const isConfirming = confirmState?.sessionId === session.id
  const isStreaming = session.isStreaming

  return (
    <Flex
      key={session.id}
      align="center"
      gap={2}
      className={`sidebar-session-item ${isActiveSession ? 'active' : 'inactive'} ${isArchivedOrDeleted ? 'opacity-70' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        onSelectSession(session.id)
      }}
    >
      <span className="sidebar-session-icon">
        {isStreaming ? (
          <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse outline outline-2 outline-blue-500/30" />
        ) : (
          <Message />
        )}
      </span>
      <span className="sidebar-session-summary">{session.summary}</span>

      {!isConfirming && (
        <div className="sidebar-session-right">
          <span className="sidebar-session-time">
            {session.relativeTime}
          </span>
          <Flex className="sidebar-session-actions-box">
            {!isArchivedOrDeleted ? (
              <>
                <Button
                  variant="ghost"
                  size="none"
                  className="sidebar-session-action-btn-archive"
                  title="归档对话"
                  onClick={(e) => {
                    e.stopPropagation()
                    onArchiveSession?.(session.id, true)
                  }}
                >
                  <Archive className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="none"
                  className="sidebar-session-action-btn-delete"
                  title="删除对话"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteSession?.(session.id)
                  }}
                >
                  <Trash className="w-3.5 h-3.5" />
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="none"
                  className="sidebar-session-action-btn-archive"
                  title="取消归档/恢复"
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmState({ sessionId: session.id, action: 'restore' })
                  }}
                >
                  <Unarchive className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="none"
                  className="sidebar-session-action-btn-delete"
                  title="彻底删除"
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmState({ sessionId: session.id, action: 'delete' })
                  }}
                >
                  <Trash className="w-3.5 h-3.5" />
                </Button>
              </>
            )}
          </Flex>
        </div>
      )}

      {isConfirming && (
        <Flex
          align="center"
          gap={1.5}
          className="sidebar-session-confirm-bar"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="sidebar-session-confirm-text">
            {confirmState.action === 'delete' ? '确定删除?' : '确定恢复?'}
          </span>
          <Button
            variant="ghost"
            size="none"
            className="sidebar-session-confirm-btn-yes"
            title="确认"
            onClick={(e) => {
              e.stopPropagation()
              if (confirmState.action === 'delete') {
                onDeleteSession?.(session.id)
              } else {
                onArchiveSession?.(session.id, false)
              }
              setConfirmState(null)
            }}
          >
            <Check className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="none"
            className="sidebar-session-confirm-btn-no"
            title="取消"
            onClick={(e) => {
              e.stopPropagation()
              setConfirmState(null)
            }}
          >
            <Close className="w-3.5 h-3.5" />
          </Button>
        </Flex>
      )}
    </Flex>
  )
}
