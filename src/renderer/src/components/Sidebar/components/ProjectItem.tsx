import React from 'react'
import { IconFolder as Folder, IconMoreHorizontal as MoreHorizontal, IconChevron as Chevron, IconMessagePlus as MessagePlus } from '../../Icons'
import Button from '../../ui/Button'
import Flex from '../../ui/Flex'
import SessionItem from './SessionItem'
import type { SidebarProject } from '../types'

interface ProjectItemProps {
  proj: SidebarProject
  isActiveProject: boolean
  activeSessionId: string | null
  expandedProjects: Record<string, boolean>
  setExpandedProjects: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  showArchivedFor: Record<string, boolean>
  setShowArchivedFor: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  showDeletedFor: Record<string, boolean>
  setShowDeletedFor: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  confirmState: { sessionId: string; action: 'archive' | 'unarchive' | 'delete' | 'restore' | 'forceDelete' } | null
  setConfirmState: (state: any) => void
  onSelectProject: (project: SidebarProject) => void
  onSelectSession: (sessionId: string) => void
  onArchiveSession?: (sessionId: string, archive: boolean) => void
  onDeleteSession?: (sessionId: string) => void
  buttonRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>
  handleOpenMenu: (e: React.MouseEvent, projId: string) => void
}

export default function ProjectItem({
  proj,
  isActiveProject,
  activeSessionId,
  expandedProjects,
  setExpandedProjects,
  showArchivedFor,
  setShowArchivedFor,
  showDeletedFor,
  setShowDeletedFor,
  confirmState,
  setConfirmState,
  onSelectProject,
  onSelectSession,
  onArchiveSession,
  onDeleteSession,
  buttonRefs,
  handleOpenMenu
}: ProjectItemProps): React.ReactElement {
  const hasSessions = proj.sessions.length > 0
  const isExpanded = expandedProjects[proj.id] !== false

  const activeSessions = proj.sessions.filter((s) => !s.isArchived && !s.isDeleted)
  const archivedSessions = proj.sessions.filter((s) => s.isArchived && !s.isDeleted)
  const deletedSessions = proj.sessions.filter((s) => s.isDeleted)

  return (
    <div>
      {/* 项目主行 */}
      <Flex
        align="center"
        justify="between"
        className={`sidebar-project-row ${isActiveProject ? 'active' : 'inactive'}`}
        onClick={() => {
          onSelectProject(proj)
          setExpandedProjects((prev) => ({ ...prev, [proj.id]: expandedProjects[proj.id] === false }))
        }}
      >
        <Flex align="center" gap={1.5} className="sidebar-project-left">
          <Chevron
            className="sidebar-project-chevron"
            style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0)' }}
          />
          <span className="sidebar-project-folder"><Folder /></span>
          <span className="truncate">{proj.name}</span>
        </Flex>

        {/* Hover 操作按钮组 */}
        <Flex className="sidebar-project-hover-actions">
          <Button
            variant="ghost"
            size="none"
            className="sidebar-project-action-btn"
            title="新对话"
            onClick={(e) => {
              e.stopPropagation()
              if (!isActiveProject) onSelectProject(proj)
              onSelectSession(`${proj.id}__new`)
            }}
          >
            <MessagePlus className="w-3.5 h-3.5" />
          </Button>

          <div className="relative">
            <button
              ref={(el) => {
                if (el) buttonRefs.current[proj.id] = el as unknown as HTMLDivElement
              }}
              className="sidebar-project-more-btn"
              title="更多"
              onClick={(e) => handleOpenMenu(e, proj.id)}
            >
              <MoreHorizontal />
            </button>
          </div>
        </Flex>
      </Flex>

      {/* Session 子列表 */}
      {hasSessions && isExpanded && (
        <div className="sidebar-sessions-container">
          {activeSessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isActiveSession={activeSessionId === session.id}
              confirmState={confirmState}
              setConfirmState={setConfirmState}
              onSelectSession={onSelectSession}
              onArchiveSession={onArchiveSession}
              onDeleteSession={onDeleteSession}
            />
          ))}

          {/* 归档对话组 */}
          {archivedSessions.length > 0 && (
            <div className="mt-1">
              <div
                className="sidebar-sub-toggle"
                onClick={(e) => {
                  e.stopPropagation()
                  setShowArchivedFor((prev) => ({ ...prev, [proj.id]: !prev[proj.id] }))
                }}
              >
                <span>已归档 ({archivedSessions.length})</span>
              </div>
              {showArchivedFor[proj.id] &&
                archivedSessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    isActiveSession={activeSessionId === session.id}
                    confirmState={confirmState}
                    setConfirmState={setConfirmState}
                    onSelectSession={onSelectSession}
                    onArchiveSession={onArchiveSession}
                    onDeleteSession={onDeleteSession}
                    isArchivedOrDeleted
                  />
                ))}
            </div>
          )}

          {/* 回收站对话组 */}
          {deletedSessions.length > 0 && (
            <div className="mt-1">
              <div
                className="sidebar-sub-toggle"
                onClick={(e) => {
                  e.stopPropagation()
                  setShowDeletedFor((prev) => ({ ...prev, [proj.id]: !prev[proj.id] }))
                }}
              >
                <span>回收站 ({deletedSessions.length})</span>
              </div>
              {showDeletedFor[proj.id] &&
                deletedSessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    isActiveSession={activeSessionId === session.id}
                    confirmState={confirmState}
                    setConfirmState={setConfirmState}
                    onSelectSession={onSelectSession}
                    onArchiveSession={onArchiveSession}
                    onDeleteSession={onDeleteSession}
                    isArchivedOrDeleted
                  />
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
