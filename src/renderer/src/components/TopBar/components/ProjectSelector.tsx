import React from 'react'
import Button from '../../ui/Button'
import Flex from '../../ui/Flex'
import Card from '../../ui/Card'
import type { WorkspaceInfo } from '@shared/types/workspace'
import { desktopApi } from '../../../shared/desktop'

interface ProjectSelectorProps {
  workspace: WorkspaceInfo | null
  selectedIDE: string
  setSelectedIDE: (ide: string) => void
  installedEditors: Array<{ id: string; name: string; exePath: string | null; iconPath: string | null }>
  ideDropdownOpen: boolean
  setIdeDropdownOpen: (open: boolean) => void
}

export default function ProjectSelector({
  workspace,
  selectedIDE,
  setSelectedIDE,
  installedEditors,
  ideDropdownOpen,
  setIdeDropdownOpen
}: ProjectSelectorProps): React.ReactElement {
  const getIDEIcon = (id: string) => {
    const targetEditor = installedEditors.find((e) => e.id === id)
    if (targetEditor?.iconPath) {
      const isDataUri = targetEditor.iconPath.startsWith('data:')
      const finalSrc = isDataUri
        ? targetEditor.iconPath
        : `codez-file:///${targetEditor.iconPath.replace(/\\/g, '/')}`

      const needsScale = id === 'VSCode' || id === 'Cursor'

      return (
        <img
          src={finalSrc}
          alt={id}
          style={{
            width: '14px',
            height: '14px',
            objectFit: 'contain',
            flexShrink: 0,
            transform: needsScale ? 'scale(1.45) translateX(0.8px)' : 'none',
            transformOrigin: 'center'
          }}
          onError={(e) => {
            e.currentTarget.style.display = 'none'
          }}
        />
      )
    }

    const letter = id.charAt(0).toUpperCase()
    return (
      <Flex
        align="center"
        justify="center"
        style={{
          width: '14px',
          height: '14px',
          borderRadius: '3px',
          background: '#3b82f6',
          color: '#fff',
          fontSize: '10px',
          fontWeight: 'bold',
          flexShrink: 0,
          fontFamily: 'sans-serif'
        }}
      >
        {letter}
      </Flex>
    )
  }

  return (
    <div className="topbar-left relative">
      <Flex align="center" gap={0} className="topbar-project-badge" style={{ height: '28px' }}>
        <div className="topbar-project-name">{workspace?.name || 'Codez'}</div>
        <div className="topbar-project-divider"></div>

        <Button
          variant="ghost"
          size="none"
          className="topbar-ide-btn"
          onClick={() => {
            if (workspace) {
              const cur = installedEditors.find((e) => e.id === selectedIDE)
              void desktopApi.workspace.openInEditor(
                workspace.rootPath,
                selectedIDE,
                cur?.exePath ?? undefined
              )
            }
          }}
          disabled={!workspace}
          title={workspace ? `使用 ${selectedIDE} 打开当前项目` : `请先打开项目`}
          style={{ width: '22px', height: '22px', border: 'none', background: 'transparent' }}
        >
          {getIDEIcon(selectedIDE)}
        </Button>

        <div className="topbar-ide-separator"></div>

        <Button
          variant="ghost"
          size="none"
          onClick={() => setIdeDropdownOpen(!ideDropdownOpen)}
          className="topbar-ide-dropdown-btn"
        >
          <span className="topbar-ide-dropdown-arrow">▼</span>
        </Button>
      </Flex>

      {ideDropdownOpen && (
        <>
          <div className="fixed inset-0 z-[40]" onClick={() => setIdeDropdownOpen(false)}></div>
          <Card
            variant="default"
            className="topbar-dropdown-card"
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: '4px',
              zIndex: 50,
              minWidth: '160px',
              padding: '4px'
            }}
          >
            {installedEditors.map((editor) => (
              <Flex
                key={editor.id}
                align="center"
                gap={2}
                className={`topbar-dropdown-item ${selectedIDE === editor.id ? 'is-selected' : ''}`}
                style={{
                  padding: '6px 10px',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '12px'
                }}
                onClick={() => {
                  setSelectedIDE(editor.id)
                  localStorage.setItem('codez_selected_ide', editor.id)
                  if (workspace?.id) {
                    localStorage.setItem(`codez_selected_ide_for_project_${workspace.id}`, editor.id)
                  }
                  setIdeDropdownOpen(false)
                }}
              >
                {getIDEIcon(editor.id)}
                <span>{editor.name}</span>
              </Flex>
            ))}
          </Card>
        </>
      )}
    </div>
  )
}
