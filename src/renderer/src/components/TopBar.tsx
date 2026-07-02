import React from 'react'
import { useWorkspaceStore } from '../stores/workspaceStore'
import Button from './ui/Button'
import Input from './ui/Input'
import Flex from './ui/Flex'
import Card from './ui/Card'
import IconMail from './icons/IconMail'
import IconHistory from './icons/IconHistory'
import IconTerminal from './icons/IconTerminal'
import IconMinimize from './icons/IconMinimize'
import IconMaximize from './icons/IconMaximize'
import IconRestore from './icons/IconRestore'
import IconClose from './icons/IconClose'
import IconSun from './icons/IconSun'
import IconMoon from './icons/IconMoon'
import IconMonitor from './icons/IconMonitor'

import './TopBar.css'

interface TopBarProps {
  onOpenProject: () => void
  terminalOpen?: boolean
  onToggleTerminal?: () => void
  onOpenTasks?: () => void
  hasWorkspace?: boolean
}

/** 向主进程发送窗口控制指令 */
function sendWindowControl(action: 'minimize' | 'maximize' | 'close') {
  try {
    // electron-vite 的 preload 可能未暴露此 API，直接通过 ipcRenderer 的全局桥接发送
    // 这里使用类型断言绕过检查，因为主进程已在 ipcMain 监听 'window-control'
    const win = window as any
    if (win.electron?.ipcRenderer) {
      win.electron.ipcRenderer.send('window-control', action)
    }
  } catch {
    // 非 Electron 环境（浏览器调试）静默忽略
  }
}

export default function TopBar({
  onOpenProject,
  terminalOpen = false,
  onToggleTerminal,
  onOpenTasks,
  hasWorkspace = false
}: TopBarProps): React.ReactElement {
  const workspace = useWorkspaceStore((s) => s.workspace)
  const [searchFocused, setSearchFocused] = React.useState(false)
  const [isMaximized, setIsMaximized] = React.useState(false)
  const [selectedIDE, setSelectedIDE] = React.useState<string>(() => {
    try {
      return localStorage.getItem('codez_selected_ide') || 'VSCode'
    } catch {
      return 'VSCode'
    }
  })
  const [ideDropdownOpen, setIdeDropdownOpen] = React.useState(false)
  const [themeSource, setThemeSource] = React.useState<'system' | 'light' | 'dark'>('system')
  const [activeSkillsCount, setActiveSkillsCount] = React.useState(0)

  // 定期检查活跃技能数量
  React.useEffect(() => {
    if (!workspace) {
      setActiveSkillsCount(0)
      return
    }
    const checkSkills = async () => {
      try {
        const skills = await window.api.skill.getAll(workspace.rootPath)
        setActiveSkillsCount(skills.filter((s: any) => s.enabled).length)
      } catch {}
    }
    checkSkills()
    const interval = setInterval(checkSkills, 2000)
    return () => clearInterval(interval)
  }, [workspace])

  const [installedEditors, setInstalledEditors] = React.useState<Array<{ id: string; name: string; exePath: string | null; iconPath: string | null }>>([
    { id: 'VSCode', name: 'VSCode', exePath: null, iconPath: null }
  ])

  const getIDEIcon = (id: string) => {
    // 1. 优先使用本地动态提取的系统真实图标 (.svg/.ico/.png)
    const targetEditor = installedEditors.find(e => e.id === id)
    if (targetEditor?.iconPath) {
      // 兼容主进程尚未重启时传来的旧物理路径
      const isDataUri = targetEditor.iconPath.startsWith('data:')
      const finalSrc = isDataUri 
        ? targetEditor.iconPath 
        : `codez-file:///${targetEditor.iconPath.replace(/\\/g, '/')}`
        
      // 针对原生自带大白边且物理重心偏移的编辑器图标做特殊的视觉缩放与居中补偿
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
            // 图片完全崩溃无法渲染时，将其隐藏，由于有外层 div 会保持布局但避免白框
            e.currentTarget.style.display = 'none'
          }}
        />
      )
    }

    // 2. 如果主进程完全找不到任何物理图标返回了 null，使用轻量极速的 CSS 字母块兜底
    const letter = id.charAt(0).toUpperCase()
    return (
      <Flex align="center" justify="center" style={{ width: '14px', height: '14px', borderRadius: '3px', background: '#3b82f6', color: '#fff', fontSize: '10px', fontWeight: 'bold', flexShrink: 0, fontFamily: 'sans-serif' }}>
        {letter}
      </Flex>
    )
  }

  // 记住项目级别的编辑器打开习惯
  React.useEffect(() => {
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

  React.useEffect(() => {
    const win = window as any
    if (win.electron?.ipcRenderer) {
      const handler = (_event: any, state: boolean) => setIsMaximized(state)
      win.electron.ipcRenderer.on('window-maximized-state', handler)
      
      let cleanup: (() => void) | undefined
      // Initialize theme source state for UI display only
      if (window.api?.theme) {
        window.api.theme.get().then((info) => {
          setThemeSource(info.themeSource)
        })

        // Just update local state for the moon/sun icon
        cleanup = window.api.theme.onUpdated((info) => {
          setThemeSource(info.themeSource)
        })
        
        // This is necessary to store cleanup and remove listener properly.
        // We do it at the end of effect.
      }
      
      // 检测本地安装 of IDE 并过滤习惯记忆
      window.api.workspace.detectInstalledEditors().then((editors) => {
        if (editors && editors.length > 0) {
          setInstalledEditors(editors)
          const editorIds = editors.map(e => e.id)
          
          // 如果当前有项目，则优先检查项目级习惯
          let defaultIDE = editors[0].id
          if (workspace?.id) {
            const projectStored = localStorage.getItem(`codez_selected_ide_for_project_${workspace.id}`)
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
      }).catch((err) => {
        console.error('检测 IDE 失败:', err)
        // 降级兜底显示常用编辑器
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
      {/* 左侧：Logo已隐藏 + 三段式项目名与 IDE 快捷唤起 */}
      <div className="topbar-left relative">
        <Flex 
          align="center"
          gap={0}
          className="topbar-project-badge"
          style={{ height: '28px' }}
        >
          {/* 1. 项目名称 */}
          <div className="topbar-project-name">
            {workspace?.name || 'Codez'}
          </div>

          {/* 分隔线 */}
          <div className="topbar-project-divider"></div>

          {/* 2. 中间可点击的 IDE 图标 (带 Tooltip 和点击命令) */}
          <Button
            variant="ghost"
            size="none"
            className="topbar-ide-btn"
            onClick={() => {
              if (workspace) {
                const cur = installedEditors.find(e => e.id === selectedIDE)
                window.api.workspace.openInEditor(workspace.rootPath, selectedIDE, cur?.exePath || null)
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
            <div className="topbar-ide-dropdown-overlay" onClick={() => setIdeDropdownOpen(false)}></div>
            <Card 
              variant="default"
              className="topbar-ide-dropdown-card"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="topbar-ide-dropdown-title">选择目标 IDE</div>
              {installedEditors.map((item) => (
                <Flex
                  key={item.id}
                  align="center"
                  justify="between"
                  className={`topbar-ide-item ${selectedIDE === item.id ? 'selected' : ''}`}
                  onClick={() => {
                    setSelectedIDE(item.id)
                    try {
                      localStorage.setItem('codez_selected_ide', item.id)
                      if (workspace?.id) {
                        localStorage.setItem(`codez_selected_ide_for_project_${workspace.id}`, item.id)
                      }
                    } catch {}
                    setIdeDropdownOpen(false)
                  }}
                >
                  <Flex align="center" gap={2}>
                    {getIDEIcon(item.id)}
                    <span>{item.name}</span>
                  </Flex>
                  {selectedIDE === item.id && <span className="topbar-ide-check">✓</span>}
                </Flex>
              ))}
            </Card>
          </>
        )}
      </div>

      {/* 中间：搜索栏与 Plan 胶囊 */}
      <div className="topbar-center" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <Input
          className="global-search"
          type="text"
          placeholder={searchFocused ? '搜索项目、文件、会话、Workflow...' : '⌘K 搜索...'}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
        />
      </div>

      {/* 右侧：用户 + 窗口控制 */}
      <div className="topbar-right">
        <Button
          variant="ghost"
          size="none"
          className="user-menu-btn topbar-action-btn-normal"
          title={`主题切换 (${themeSource === 'system' ? '系统' : themeSource === 'dark' ? '深色' : '浅色'})`}
          onClick={() => {
            const nextMap: Record<string, 'system'|'light'|'dark'> = {
              'system': 'light',
              'light': 'dark',
              'dark': 'system'
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
          title={hasWorkspace ? "任务历史" : "请先打开项目"}
          onClick={hasWorkspace ? onOpenTasks : undefined}
          disabled={!hasWorkspace}
        >
          <IconHistory />
        </Button>

        <Button
          variant="ghost"
          size="none"
          className={`user-menu-btn ${!hasWorkspace ? 'topbar-action-btn-disabled' : terminalOpen ? 'topbar-action-btn-active' : 'topbar-action-btn-normal'}`}
          title={hasWorkspace ? "切换显示终端" : "请先打开一个项目以使用终端"}
          onClick={hasWorkspace ? onToggleTerminal : undefined}
          disabled={!hasWorkspace}
        >
          <IconTerminal />
        </Button>

        <Button variant="ghost" size="none" className="user-menu-btn" title="用户菜单">
          U
        </Button>

        <div className="window-controls">
          <button
            className="window-control-btn"
            title="最小化"
            onClick={() => sendWindowControl('minimize')}
          >
            <IconMinimize />
          </button>
          <button
            className="window-control-btn"
            title={isMaximized ? "向下还原" : "最大化"}
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
