import React, { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { IconEdit as Pencil, IconSearch as Search, IconGrid as Grid, IconClock as Clock, IconFolder as Folder, IconMoreHorizontal as MoreHorizontal, IconSettings as Gear, IconMessage as Message, IconArchive as Archive, IconUnarchive as Unarchive, IconCheck as Check, IconClose as Close, IconTrash as Trash, IconChevron as Chevron, IconExpandAll as ExpandAll, IconCollapseAll as CollapseAll, IconMessagePlus as MessagePlus, IconFolderPlus as FolderPlus } from './Icons'
import Button from './ui/Button'
import Flex from './ui/Flex'
import Stack from './ui/Stack'
import './Sidebar.css'

export interface SidebarSession {
  id: string
  summary: string
  relativeTime: string
  isArchived?: boolean
  isDeleted?: boolean
}

export interface SidebarProject {
  id: string
  name: string
  sessions: SidebarSession[]
}

interface SidebarProps {
  projects: SidebarProject[]
  activeSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onArchiveSession?: (sessionId: string, archive: boolean) => void
  onDeleteSession?: (sessionId: string) => void
  onRestoreSession?: (sessionId: string) => void
  onSelectProject: (project: SidebarProject) => void
  onOpenProject: () => void
  activeProjectId?: string
  onShowInExplorer?: (projectId: string) => void
  onRenameProject?: (projectId: string, newName: string) => void
  onRemoveProject?: (projectId: string) => void
  onOpenSettings?: () => void
}

export default function Sidebar({
  projects,
  activeSessionId,
  onSelectSession,
  onArchiveSession,
  onDeleteSession,
  onRestoreSession,
  onSelectProject,
  onOpenProject,
  activeProjectId,
  onShowInExplorer,
  onRenameProject,
  onRemoveProject,
  onOpenSettings
}: SidebarProps): React.ReactElement {
  const [menuOpenForId, setMenuOpenForId] = useState<string | null>(null)
  const [confirmState, setConfirmState] = useState<{ sessionId: string; action: 'archive' | 'unarchive' | 'delete' | 'restore' | 'forceDelete' } | null>(null)
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({})
  const [showArchivedFor, setShowArchivedFor] = useState<Record<string, boolean>>({})
  const [showDeletedFor, setShowDeletedFor] = useState<Record<string, boolean>>({})

  const isAnyCollapsed = projects.some(p => expandedProjects[p.id] === false)
  const toggleAllProjects = () => {
    if (isAnyCollapsed) {
      setExpandedProjects({})
    } else {
      const next: Record<string, boolean> = {}
      projects.forEach(p => { next[p.id] = false })
      setExpandedProjects(next)
    }
  }
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 })
  const buttonRefs = useRef<Record<string, HTMLDivElement | null>>({})
  
  const handleOpenMenu = (e: React.MouseEvent, projId: string) => {
    e.stopPropagation()
    const btn = buttonRefs.current[projId]
    if (btn) {
      const rect = btn.getBoundingClientRect()
      setMenuPosition({ top: rect.top, left: rect.right + 8 })
      setMenuOpenForId(menuOpenForId === projId ? null : projId)
    }
  }

  useEffect(() => {
    const handleScroll = () => {
      setMenuOpenForId(null)
      setConfirmState(null)
    }
    window.addEventListener('resize', handleScroll)
    document.addEventListener('scroll', handleScroll, true)
    return () => {
      window.removeEventListener('resize', handleScroll)
      document.removeEventListener('scroll', handleScroll, true)
    }
  }, [])

  const toggleArchived = (projId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setShowArchivedFor(prev => ({ ...prev, [projId]: !prev[projId] }))
  }

  return (
    <aside className="sidebar-container" style={{ width: '100%' }}>
      <Stack className="flex-1 overflow-hidden">
        {/* 全局操作 */}
        <Stack className="sidebar-action-list" gap="4px">
          <Button
            variant="ghost"
            size="none"
            className="sidebar-action-btn"
            onClick={onOpenProject}
          >
            <Flex align="center" gap={3}>
              <span className="sidebar-action-icon"><Pencil /></span>
              <span>新项目</span>
            </Flex>
          </Button>
          <Button variant="ghost" size="none" className="sidebar-action-btn">
            <Flex align="center" gap={3}>
              <span className="sidebar-action-icon"><Search /></span><span>搜索</span>
            </Flex>
          </Button>
          <Button variant="ghost" size="none" className="sidebar-action-btn">
            <Flex align="center" gap={3}>
              <span className="sidebar-action-icon"><Grid /></span><span>插件</span>
            </Flex>
          </Button>
          <Button variant="ghost" size="none" className="sidebar-action-btn">
            <Flex align="center" gap={3}>
              <span className="sidebar-action-icon"><Clock /></span><span>自动化</span>
            </Flex>
          </Button>
        </Stack>

        {/* 项目 + Session 列表区 */}
        <div className="sidebar-project-section">
          <Flex align="center" justify="between" className="sidebar-section-header">
            <div className="sidebar-section-title">项目</div>
            <Flex align="center" gap={1} className="sidebar-section-actions">
              <Button
                variant="icon"
                size="none"
                title={isAnyCollapsed ? "全部展开" : "全部折叠"}
                onClick={toggleAllProjects}
              >
                {isAnyCollapsed ? <ExpandAll className="w-3.5 h-3.5" /> : <CollapseAll className="w-3.5 h-3.5" />}
              </Button>
              <Button
                variant="icon"
                size="none"
                title="添加新项目"
                onClick={onOpenProject}
              >
                <FolderPlus className="w-3.5 h-3.5" />
              </Button>
            </Flex>
          </Flex>

          {projects.length === 0 ? (
            <p className="sidebar-empty-tip">
              暂无项目，打开一个文件夹开始
            </p>
          ) : (
            <Stack className="sidebar-project-list">
              {projects.map((proj) => {
                const isActiveProject = activeProjectId === proj.id
                const hasSessions = proj.sessions.length > 0
                const isExpanded = expandedProjects[proj.id] !== false

                return (
                  <div key={proj.id}>
                    {/* 项目行 */}
                    <Flex
                      align="center"
                      justify="between"
                      className={`sidebar-project-row ${isActiveProject ? 'active' : 'inactive'}`}
                      onClick={() => {
                        onSelectProject(proj)
                        setExpandedProjects(prev => ({ ...prev, [proj.id]: expandedProjects[proj.id] === false }))
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

                      {/* Hover 操作组 */}
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
                            ref={(el) => { if (el) buttonRefs.current[proj.id] = el as unknown as HTMLDivElement }}
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
                        {/* 活跃会话 */}
                        {proj.sessions.filter(s => !s.isArchived && !s.isDeleted).map((session) => {
                          const isActiveSession = activeSessionId === session.id
                          return (
                            <Flex
                              key={session.id}
                              align="center"
                              gap={2}
                              className={`sidebar-session-item ${isActiveSession ? 'active' : 'inactive'}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                onSelectSession(session.id)
                              }}
                            >
                              <span className="sidebar-session-icon"><Message /></span>
                              <span className="sidebar-session-summary">{session.summary}</span>
                              
                              {confirmState?.sessionId !== session.id && (
                                <>
                                  <span className="sidebar-session-time group-hover/session:hidden">
                                    {session.relativeTime}
                                  </span>
                                  <Flex className="sidebar-session-actions-box">
                                    <Button
                                      variant="ghost"
                                      size="none"
                                      className="sidebar-session-action-btn-archive"
                                      title="归档对话"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setConfirmState({ sessionId: session.id, action: 'archive' })
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
                                        setConfirmState({ sessionId: session.id, action: 'delete' })
                                      }}
                                    >
                                      <Trash className="w-3.5 h-3.5" />
                                    </Button>
                                  </Flex>
                                </>
                              )}

                              {confirmState?.sessionId === session.id && (
                                <Flex
                                  align="center"
                                  gap={1.5}
                                  className="sidebar-session-confirm-bar"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <span className="sidebar-session-confirm-text">
                                    {confirmState.action === 'delete' ? '确定删除?' : '确定归档?'}
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
                                        onArchiveSession?.(session.id, true)
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
                        })}
                        
                        {/* 归档区域 */}
                        {proj.sessions.filter(s => s.isArchived && !s.isDeleted).length > 0 && (
                          <div className="mt-1">
                            <Flex 
                              align="center"
                              gap={2}
                              className="sidebar-archived-toggle"
                              onClick={(e) => toggleArchived(proj.id, e)}
                            >
                              <span className="sidebar-archived-toggle-arrow" style={{ transform: showArchivedFor[proj.id] ? 'rotate(90deg)' : 'rotate(0)' }}>▶</span>
                              已归档对话 ({proj.sessions.filter(s => s.isArchived && !s.isDeleted).length})
                            </Flex>
                            {showArchivedFor[proj.id] && proj.sessions.filter(s => s.isArchived && !s.isDeleted).map((session) => {
                              const isActiveSession = activeSessionId === session.id
                              return (
                                <Flex
                                  key={session.id}
                                  align="center"
                                  gap={2}
                                  className={`sidebar-session-item ${isActiveSession ? 'active' : 'inactive'}`}
                                  style={{ opacity: 0.7 }}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    onSelectSession(session.id)
                                  }}
                                >
                                  <span className="sidebar-session-icon"><Message /></span>
                                  <span className="sidebar-session-summary sidebar-session-summary-archived">{session.summary}</span>
                                  
                                  {confirmState?.sessionId !== session.id && (
                                    <>
                                      <span className="sidebar-session-time group-hover/session:hidden">
                                        {session.relativeTime}
                                      </span>
                                      <Flex className="sidebar-session-actions-box">
                                        <Button
                                          variant="ghost"
                                          size="none"
                                          className="sidebar-session-action-btn-archive"
                                          title="恢复对话"
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            setConfirmState({ sessionId: session.id, action: 'unarchive' })
                                          }}
                                        >
                                          <Unarchive className="w-3.5 h-3.5" />
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          size="none"
                                          className="sidebar-session-action-btn-delete"
                                          title="删除对话"
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            setConfirmState({ sessionId: session.id, action: 'delete' })
                                          }}
                                        >
                                          <Trash className="w-3.5 h-3.5" />
                                        </Button>
                                      </Flex>
                                    </>
                                  )}

                                  {confirmState?.sessionId === session.id && (
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
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </Stack>
          )}
        </div>
      </Stack>

      <div className="sidebar-footer">
        <Button variant="ghost" size="none" className="sidebar-footer-settings-btn" onClick={onOpenSettings}>
          <Flex align="center" gap={3}>
            <span className="sidebar-action-icon"><Gear /></span><span>设置</span>
          </Flex>
        </Button>
      </div>

      {/* Portal 团队项目菜单 */}
      {menuOpenForId && (
        (() => {
          const targetProject = projects.find(p => p.id === menuOpenForId)
          if (!targetProject) return null

          return createPortal(
            <>
              <div className="sidebar-context-overlay" onClick={(e) => { e.stopPropagation(); setMenuOpenForId(null) }}></div>
              <div
                className="sidebar-context-menu"
                style={{ top: menuPosition.top, left: menuPosition.left }}
              >
                {[
                  {
                    label: '在资源管理器中打开',
                    onClick: () => {
                      onShowInExplorer?.(targetProject.id)
                      setMenuOpenForId(null)
                    },
                    className: 'sidebar-context-item'
                  },
                  {
                    label: '重命名项目',
                    onClick: () => {
                      const newName = prompt('输入新的项目名称:', targetProject.name)
                      if (newName && newName.trim()) {
                        onRenameProject?.(targetProject.id, newName.trim())
                      }
                      setMenuOpenForId(null)
                    },
                    className: 'sidebar-context-item'
                  },
                  {
                    isDivider: true
                  },
                  {
                    label: '移除此项目',
                    onClick: () => {
                      if (confirm(`确定从列表中移除项目 "${targetProject.name}" 吗？`)) {
                        onRemoveProject?.(targetProject.id)
                      }
                      setMenuOpenForId(null)
                    },
                    className: 'sidebar-context-item-danger'
                  }
                ].map((item, idx) => {
                  if (item.isDivider) {
                    return <div key={idx} className="sidebar-context-divider" />
                  }
                  return (
                    <div
                      key={idx}
                      onClick={(e) => {
                        e.stopPropagation()
                        item.onClick?.()
                      }}
                      className={item.className}
                    >
                      {item.label}
                    </div>
                  )
                })}
              </div>
            </>,
            document.body
          )
        })()
      )}
    </aside>
  )
}
