import React, { useState, useEffect, useRef } from 'react'
import {
  IconEdit as Pencil,
  IconSearch as Search,
  IconGrid as Grid,
  IconClock as Clock,
  IconSettings as Gear,
  IconExpandAll as ExpandAll,
  IconCollapseAll as CollapseAll,
  IconFolderPlus as FolderPlus
} from '../Icons'
import Button from '../ui/Button'
import Flex from '../ui/Flex'
import Stack from '../ui/Stack'
import './Sidebar.css'

import type { SidebarProps } from './types'
import ProjectItem from './components/ProjectItem'
import ProjectMenuPopover from './components/ProjectMenuPopover'

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
  const [confirmState, setConfirmState] = useState<{
    sessionId: string
    action: 'archive' | 'unarchive' | 'delete' | 'restore' | 'forceDelete'
  } | null>(null)
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({})
  const [showArchivedFor, setShowArchivedFor] = useState<Record<string, boolean>>({})

  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 })
  const buttonRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const [toastData, setToastData] = useState<{
    sessionId: string
    sessionSummary: string
    action: 'delete' | 'archive'
    timeoutId: ReturnType<typeof setTimeout>
  } | null>(null)

  const isAnyCollapsed = projects.some((p) => expandedProjects[p.id] === false)
  const toggleAllProjects = () => {
    if (isAnyCollapsed) {
      setExpandedProjects({})
    } else {
      const next: Record<string, boolean> = {}
      projects.forEach((p) => {
        next[p.id] = false
      })
      setExpandedProjects(next)
    }
  }

  const getSessionSummary = (sessionId: string) => {
    for (const proj of projects) {
      const session = proj.sessions.find(s => s.id === sessionId)
      if (session) return session.summary
    }
    return ''
  }

  const handleDeleteSession = (sessionId: string) => {
    const summary = getSessionSummary(sessionId)
    onDeleteSession?.(sessionId)
    if (toastData?.timeoutId) clearTimeout(toastData.timeoutId)
    const timeoutId = setTimeout(() => setToastData(null), 5000)
    setToastData({ sessionId, sessionSummary: summary, action: 'delete', timeoutId })
  }

  const handleArchiveSession = (sessionId: string, archive: boolean) => {
    const summary = getSessionSummary(sessionId)
    onArchiveSession?.(sessionId, archive)
    if (archive) {
      if (toastData?.timeoutId) clearTimeout(toastData.timeoutId)
      const timeoutId = setTimeout(() => setToastData(null), 5000)
      setToastData({ sessionId, sessionSummary: summary, action: 'archive', timeoutId })
    }
  }

  const handleUndo = () => {
    if (!toastData) return
    if (toastData.action === 'delete') {
      onRestoreSession?.(toastData.sessionId)
    } else {
      onArchiveSession?.(toastData.sessionId, false)
    }
    clearTimeout(toastData.timeoutId)
    setToastData(null)
  }

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

  return (
    <aside className="sidebar-container" style={{ width: '100%' }}>
      <Stack className="flex-1 overflow-hidden" style={{ minHeight: 0 }}>
        {/* 全局操作 */}
        <Stack className="sidebar-action-list" gap="4px">
          <Button variant="ghost" size="none" className="sidebar-action-btn" onClick={onOpenProject}>
            <Flex align="center" gap={3}>
              <span className="sidebar-action-icon"><Pencil /></span>
              <span>新项目</span>
            </Flex>
          </Button>
          <Button variant="ghost" size="none" className="sidebar-action-btn">
            <Flex align="center" gap={3}>
              <span className="sidebar-action-icon"><Search /></span>
              <span>搜索</span>
            </Flex>
          </Button>
          <Button variant="ghost" size="none" className="sidebar-action-btn">
            <Flex align="center" gap={3}>
              <span className="sidebar-action-icon"><Grid /></span>
              <span>插件</span>
            </Flex>
          </Button>
          <Button variant="ghost" size="none" className="sidebar-action-btn">
            <Flex align="center" gap={3}>
              <span className="sidebar-action-icon"><Clock /></span>
              <span>自动化</span>
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
                title={isAnyCollapsed ? '全部展开' : '全部折叠'}
                onClick={toggleAllProjects}
              >
                {isAnyCollapsed ? <ExpandAll className="w-3.5 h-3.5" /> : <CollapseAll className="w-3.5 h-3.5" />}
              </Button>
              <Button variant="icon" size="none" title="添加新项目" onClick={onOpenProject}>
                <FolderPlus className="w-3.5 h-3.5" />
              </Button>
            </Flex>
          </Flex>

          {projects.length === 0 ? (
            <p className="sidebar-empty-tip">暂无项目，打开一个文件夹开始</p>
          ) : (
            <Stack className="sidebar-project-list">
              {projects.map((proj) => (
                <ProjectItem
                  key={proj.id}
                  proj={proj}
                  isActiveProject={activeProjectId === proj.id}
                  activeSessionId={activeSessionId}
                  expandedProjects={expandedProjects}
                  setExpandedProjects={setExpandedProjects}
                  showArchivedFor={showArchivedFor}
                  setShowArchivedFor={setShowArchivedFor}
                  confirmState={confirmState}
                  setConfirmState={setConfirmState}
                  onSelectProject={onSelectProject}
                  onSelectSession={onSelectSession}
                  onArchiveSession={handleArchiveSession}
                  onDeleteSession={handleDeleteSession}
                  buttonRefs={buttonRefs}
                  handleOpenMenu={handleOpenMenu}
                />
              ))}
            </Stack>
          )}
        </div>
      </Stack>

      <div className="sidebar-footer">
        <Button variant="ghost" size="none" className="sidebar-footer-settings-btn" onClick={onOpenSettings}>
          <Flex align="center" gap={3}>
            <span className="sidebar-action-icon"><Gear /></span>
            <span>设置</span>
          </Flex>
        </Button>
      </div>

      <ProjectMenuPopover
        menuOpenForId={menuOpenForId}
        setMenuOpenForId={setMenuOpenForId}
        menuPosition={menuPosition}
        projects={projects}
        onShowInExplorer={onShowInExplorer}
        onRenameProject={onRenameProject}
        onRemoveProject={onRemoveProject}
      />

      {toastData && (
        <div 
          key={toastData.timeoutId as unknown as string}
          style={{
            position: 'fixed',
            top: '24px',
            right: '24px',
            zIndex: 9999,
            backgroundColor: 'var(--bg-panel)',
            border: '1px solid var(--border-color)',
            boxShadow: '0 8px 30px rgba(0,0,0,0.12)',
            borderRadius: '8px',
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            animation: 'messageSlideIn 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards',
            color: 'var(--text-main)',
            fontSize: '13px',
            overflow: 'hidden'
          }}
        >
          <span>
            已{toastData.action === 'delete' ? '删除' : '归档'} {toastData.sessionSummary ? `"${toastData.sessionSummary}"` : '对话'}
          </span>
          <Button 
            variant="primary" 
            size="sm" 
            onClick={handleUndo}
            style={{ padding: '4px 12px', minHeight: '28px', height: '28px' }}
          >
            撤销
          </Button>
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              height: '3px',
              backgroundColor: 'var(--primary-color)',
              animation: 'toastProgressShrink 5s linear forwards'
            }}
          />
        </div>
      )}
    </aside>
  )
}

export type { SidebarSession, SidebarProject, SidebarProps } from './types'
