import React from 'react'
import { createPortal } from 'react-dom'
import type { SidebarProject } from '../types'

interface ProjectMenuPopoverProps {
  menuOpenForId: string | null
  setMenuOpenForId: (id: string | null) => void
  menuPosition: { top: number; left: number }
  projects: SidebarProject[]
  onShowInExplorer?: (projectId: string) => void
  onRenameProject?: (projectId: string, newName: string) => void
  onRemoveProject?: (projectId: string) => void
}

export default function ProjectMenuPopover({
  menuOpenForId,
  setMenuOpenForId,
  menuPosition,
  projects,
  onShowInExplorer,
  onRenameProject,
  onRemoveProject
}: ProjectMenuPopoverProps): React.ReactElement | null {
  if (!menuOpenForId) return null

  const targetProject = projects.find((p) => p.id === menuOpenForId)
  if (!targetProject) return null

  return createPortal(
    <>
      <div
        className="sidebar-context-overlay"
        onClick={(e) => {
          e.stopPropagation()
          setMenuOpenForId(null)
        }}
      ></div>
      <div className="sidebar-context-menu" style={{ top: menuPosition.top, left: menuPosition.left }}>
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
}
