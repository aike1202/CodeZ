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
  const [showDeletedFor, setShowDeletedFor] = useState<Record<string, boolean>>({})

  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 })
  const buttonRefs = useRef<Record<string, HTMLDivElement | null>>({})

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
                  showDeletedFor={showDeletedFor}
                  setShowDeletedFor={setShowDeletedFor}
                  confirmState={confirmState}
                  setConfirmState={setConfirmState}
                  onSelectProject={onSelectProject}
                  onSelectSession={onSelectSession}
                  onArchiveSession={onArchiveSession}
                  onDeleteSession={onDeleteSession}
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
    </aside>
  )
}

export type { SidebarSession, SidebarProject, SidebarProps } from './types'
