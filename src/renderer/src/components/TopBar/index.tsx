import React, { useState, useEffect } from 'react'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import Button from '../ui/Button'
import Input from '../ui/Input'
import IconHistory from '../icons/IconHistory'
import IconTerminal from '../icons/IconTerminal'
import IconSun from '../icons/IconSun'
import IconMoon from '../icons/IconMoon'
import IconMonitor from '../icons/IconMonitor'
import IconMinimize from '../icons/IconMinimize'
import IconMaximize from '../icons/IconMaximize'
import IconRestore from '../icons/IconRestore'
import IconClose from '../icons/IconClose'

import './TopBar.css'
import type { TopBarProps } from './types'
import ProjectSelector from './components/ProjectSelector'

function sendWindowControl(action: 'minimize' | 'maximize' | 'close') {
  try {
    const win = window as any
    if (win.electron?.ipcRenderer) {
      win.electron.ipcRenderer.send('window-control', action)
    }
  } catch {}
}

export default function TopBar({
  terminalOpen = false,
  onToggleTerminal,
  onOpenTasks,
  hasWorkspace = false
}: TopBarProps): React.ReactElement {
  const workspace = useWorkspaceStore((s) => s.workspace)
  const [searchFocused, setSearchFocused] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [selectedIDE, setSelectedIDE] = useState<string>(() => {
    try {
      return localStorage.getItem('codez_selected_ide') || 'VSCode'
    } catch {
      return 'VSCode'
    }
  })
  const [ideDropdownOpen, setIdeDropdownOpen] = useState(false)
  const [themeSource, setThemeSource] = useState<'system' | 'light' | 'dark'>('system')

  const [installedEditors, setInstalledEditors] = useState<
    Array<{ id: string; name: string; exePath: string | null; iconPath: string | null }>
  >([{ id: 'VSCode', name: 'VSCode', exePath: null, iconPath: null }])

  useEffect(() => {
    if (workspace?.id) {
      const projectStored = localStorage.getItem(`codez_selected_ide_for_project_${workspace.id}`)
      if (projectStored) {
        setSelectedIDE(projectStored)
      } else {
        const globalStored = localStorage.getItem('codez_selected_ide') || 'VSCode'
        setSelectedIDE(globalStored)
      }
    }
  }, [workspace?.id])

  useEffect(() => {
    const win = window as any
    if (win.electron?.ipcRenderer) {
      const handler = (_event: any, state: boolean) => setIsMaximized(state)
      win.electron.ipcRenderer.on('window-maximized-state', handler)

      let cleanup: (() => void) | undefined
      if (window.api?.theme) {
        window.api.theme.get().then((info) => {
          setThemeSource(info.themeSource)
        })

        cleanup = window.api.theme.onUpdated((info) => {
          setThemeSource(info.themeSource)
        })
      }

      window.api.workspace
        .detectInstalledEditors()
        .then((editors) => {
          if (editors && editors.length > 0) {
            setInstalledEditors(editors)
            const editorIds = editors.map((e) => e.id)

            let defaultIDE = editors[0].id
            if (workspace?.id) {
              const projectStored = localStorage.getItem(
                `codez_selected_ide_for_project_${workspace.id}`
              )
              if (projectStored && editorIds.includes(projectStored)) {
                defaultIDE = projectStored
              } else {
                const globalStored = localStorage.getItem('codez_selected_ide')
                if (globalStored && editorIds.includes(globalStored)) {
                  defaultIDE = globalStored
                }
              }
            } else {
              const globalStored = localStorage.getItem('codez_selected_ide')
              if (globalStored && editorIds.includes(globalStored)) {
                defaultIDE = globalStored
              }
            }

            setSelectedIDE(defaultIDE)
          }
        })
        .catch(() => {
          setInstalledEditors([
            { id: 'VSCode', name: 'VSCode', exePath: null, iconPath: null },
            { id: 'IntelliJ IDEA', name: 'IntelliJ IDEA', exePath: null, iconPath: null },
            { id: 'Cursor', name: 'Cursor', exePath: null, iconPath: null }
          ])
        })

      return () => {
        win.electron.ipcRenderer.removeListener('window-maximized-state', handler)
        if (cleanup) cleanup()
      }
    }
    return undefined
  }, [workspace?.id])

  return (
    <header className="topbar">
      <ProjectSelector
        workspace={workspace}
        selectedIDE={selectedIDE}
        setSelectedIDE={setSelectedIDE}
        installedEditors={installedEditors}
        ideDropdownOpen={ideDropdownOpen}
        setIdeDropdownOpen={setIdeDropdownOpen}
      />

      <div className="topbar-center" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <Input
          className="global-search"
          type="text"
          placeholder={searchFocused ? '搜索项目、文件、会话、Workflow...' : '⌘K 搜索...'}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
        />
      </div>

      <div className="topbar-right">
        <Button
          variant="ghost"
          size="none"
          className="user-menu-btn topbar-action-btn-normal"
          title={`主题切换 (${themeSource === 'system' ? '系统' : themeSource === 'dark' ? '深色' : '浅色'})`}
          onClick={() => {
            const nextMap: Record<string, 'system' | 'light' | 'dark'> = {
              system: 'light',
              light: 'dark',
              dark: 'system'
            }
            const next = nextMap[themeSource]
            setThemeSource(next)
            window.api?.theme?.set(next)
          }}
        >
          {themeSource === 'system' && <IconMonitor />}
          {themeSource === 'light' && <IconSun />}
          {themeSource === 'dark' && <IconMoon />}
        </Button>

        <Button
          variant="ghost"
          size="none"
          className={`user-menu-btn ${!hasWorkspace ? 'topbar-action-btn-disabled' : 'topbar-action-btn-normal'}`}
          title={hasWorkspace ? '任务历史' : '请先打开项目'}
          onClick={hasWorkspace ? onOpenTasks : undefined}
          disabled={!hasWorkspace}
        >
          <IconHistory />
        </Button>

        <Button
          variant="ghost"
          size="none"
          className={`user-menu-btn ${
            !hasWorkspace
              ? 'topbar-action-btn-disabled'
              : terminalOpen
                ? 'topbar-action-btn-active'
                : 'topbar-action-btn-normal'
          }`}
          title={hasWorkspace ? '切换显示终端' : '请先打开一个项目以使用终端'}
          onClick={hasWorkspace ? onToggleTerminal : undefined}
          disabled={!hasWorkspace}
        >
          <IconTerminal />
        </Button>

        <Button variant="ghost" size="none" className="user-menu-btn" title="用户菜单">
          U
        </Button>

        <div className="window-controls">
          <button className="window-control-btn" title="最小化" onClick={() => sendWindowControl('minimize')}>
            <IconMinimize />
          </button>
          <button
            className="window-control-btn"
            title={isMaximized ? '向下还原' : '最大化'}
            onClick={() => sendWindowControl('maximize')}
          >
            {isMaximized ? <IconRestore /> : <IconMaximize />}
          </button>
          <button
            className="window-control-btn topbar-window-control-close-btn"
            title="关闭"
            onClick={() => sendWindowControl('close')}
          >
            <IconClose />
          </button>
        </div>
      </div>
    </header>
  )
}

export type { TopBarProps } from './types'
