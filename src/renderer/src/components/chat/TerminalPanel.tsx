import React, { useState, useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import Button from '../ui/Button'
import Flex from '../ui/Flex'
import Stack from '../ui/Stack'
import IconClose from '../icons/IconClose'
import IconPlus from '../icons/IconPlus'
import './TerminalPanel.css'

interface TerminalTab {
  id: string
  name: string
}

interface TerminalPanelProps {
  workspaceId: string
  rootPath: string
  height: number
  setHeight: (height: number) => void
  onClose: () => void
  sidebarWidth?: number
  previewPanelWidth?: number
}

export default function TerminalPanel({
  workspaceId,
  rootPath,
  height,
  setHeight,
  onClose,
  sidebarWidth,
  previewPanelWidth
}: TerminalPanelProps): React.ReactElement {
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  
  const [clearTriggers, setClearTriggers] = useState<Record<string, number>>({})
  const [resetTriggers, setResetTriggers] = useState<Record<string, number>>({})

  useEffect(() => {
    if (tabs.length === 0) {
      const firstId = `term_${workspaceId}_${Date.now()}`
      setTabs([{ id: firstId, name: 'Terminal 1' }])
      setActiveTabId(firstId)
    }
  }, [workspaceId])

  const handleDragMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = height

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = startY - moveEvent.clientY
      const newHeight = Math.max(140, Math.min(window.innerHeight * 0.6, startHeight + deltaY))
      setHeight(newHeight)
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.body.style.cursor = 'row-resize'
  }

  const handleAddTab = () => {
    const nextNum = tabs.length + 1
    const newId = `term_${workspaceId}_${Date.now()}`
    setTabs([...tabs, { id: newId, name: `Terminal ${nextNum}` }])
    setActiveTabId(newId)
  }

  const handleCloseTab = async (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation()
    await window.api.terminal.kill(tabId)
    
    const newTabs = tabs.filter(t => t.id !== tabId)
    setTabs(newTabs)
    
    if (activeTabId === tabId) {
      if (newTabs.length > 0) {
        setActiveTabId(newTabs[newTabs.length - 1].id)
      } else {
        onClose()
      }
    }
  }

  const handleClear = () => {
    if (activeTabId) {
      setClearTriggers(prev => ({ ...prev, [activeTabId]: (prev[activeTabId] || 0) + 1 }))
    }
  }

  const handleReset = () => {
    if (activeTabId) {
      setResetTriggers(prev => ({ ...prev, [activeTabId]: (prev[activeTabId] || 0) + 1 }))
    }
  }

  return (
    <Stack
      className="terminal-panel"
      style={{ height }}
    >
      <div
        className="terminal-drag-bar"
        onMouseDown={handleDragMouseDown}
      />

      <Flex align="center" justify="between" className="terminal-header">
        <Flex align="center" gap={1} className="terminal-header-left">
          <span className="terminal-header-title">Terminal</span>
          
          <Flex align="center" gap={1.5} className="terminal-tabs">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId
              return (
                <Flex
                  key={tab.id}
                  align="center"
                  gap={1.5}
                  onClick={() => setActiveTabId(tab.id)}
                  className={`terminal-tab ${isActive ? 'terminal-tab--active' : ''}`}
                >
                  <span className="truncate">{tab.name}</span>
                  <Button
                    variant="ghost"
                    size="none"
                    onClick={(e) => handleCloseTab(e, tab.id)}
                    className="terminal-tab-close-btn"
                  >
                    <IconClose style={{ width: 8, height: 8 }} />
                  </Button>
                </Flex>
              )
            })}
          </Flex>

          <Button
            variant="ghost"
            size="none"
            onClick={handleAddTab}
            className="terminal-add-tab-btn"
            title="打开新终端"
          >
            <IconPlus style={{ width: 12, height: 12 }} />
          </Button>
        </Flex>

        <Flex align="center" gap={3} className="terminal-header-right">
          <Button
            variant="ghost"
            size="none"
            onClick={handleClear}
            className="terminal-action-btn"
            title="清除当前激活终端的屏幕内容"
          >
            清屏
          </Button>
          <Button
            variant="ghost"
            size="none"
            onClick={handleReset}
            className="terminal-action-btn"
            title="重置当前激活终端会话"
          >
            重置
          </Button>
          <Button
            variant="ghost"
            size="none"
            onClick={onClose}
            className="terminal-close-panel-btn"
            title="关闭终端面板"
          >
            <IconClose style={{ width: 14, height: 14 }} />
          </Button>
        </Flex>
      </Flex>

      <div className="terminal-instances-container">
        {tabs.map((tab) => (
          <TerminalInstance
            key={tab.id}
            terminalId={tab.id}
            rootPath={rootPath}
            visible={tab.id === activeTabId}
            sidebarWidth={sidebarWidth}
            previewPanelWidth={previewPanelWidth}
            height={height}
            clearTrigger={clearTriggers[tab.id] || 0}
            resetTrigger={resetTriggers[tab.id] || 0}
          />
        ))}
      </div>
    </Stack>
  )
}

/* ========================================================
   单个终端实例组件 (以 display: none/block 保留历史输出与状态)
   ======================================================== */
interface TerminalInstanceProps {
  terminalId: string
  rootPath: string
  visible: boolean
  sidebarWidth?: number
  previewPanelWidth?: number
  height: number
  clearTrigger: number
  resetTrigger: number
}

function TerminalInstance({
  terminalId,
  rootPath,
  visible,
  sidebarWidth,
  previewPanelWidth,
  height,
  clearTrigger,
  resetTrigger
}: TerminalInstanceProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!visible) return
    const handleResize = () => {
      if (fitAddonRef.current) {
        try {
          fitAddonRef.current.fit()
        } catch (err) {
          console.error('Fit error:', err)
        }
      }
    }
    
    const timer = setTimeout(handleResize, 50)
    window.addEventListener('resize', handleResize)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('resize', handleResize)
    }
  }, [visible, sidebarWidth, previewPanelWidth, height])

  useEffect(() => {
    if (visible && termRef.current) {
      termRef.current.focus()
    }
  }, [visible])

  useEffect(() => {
    if (clearTrigger > 0 && termRef.current) {
      termRef.current.clear()
      termRef.current.focus()
    }
  }, [clearTrigger])

  useEffect(() => {
    if (resetTrigger > 0) {
      handleResetInternal()
    }
  }, [resetTrigger])

  const handleResetInternal = async () => {
    if (termRef.current) {
      termRef.current.write('\r\n\x1b[33m[正在重置终端进程...]\x1b[0m\r\n')
      await window.api.terminal.kill(terminalId)
      await window.api.terminal.start(terminalId, rootPath)
      if (termRef.current && fitAddonRef.current) {
        const { cols, rows } = termRef.current
        await window.api.terminal.resize(terminalId, cols, rows)
      }
      termRef.current.write('\x1b[32m[终端进程已重启]\x1b[0m\r\n')
      termRef.current.focus()
    }
  }

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Cascadia Code, Fira Code, Consolas, monospace',
      theme: {
        background: '#f8f9fa',
        foreground: '#24292f',
        cursor: '#24292f',
        cursorAccent: '#f8f9fa',
        selectionBackground: '#add6ff',
        black: '#24292f',
        red: '#cf222e',
        green: '#116329',
        yellow: '#4d3800',
        blue: '#0969da',
        magenta: '#8250df',
        cyan: '#0594fa',
        white: '#24292f',
        brightBlack: '#57606a',
        brightRed: '#a0111f',
        brightGreen: '#1a7f37',
        brightYellow: '#6e5600',
        brightBlue: '#218bff',
        brightMagenta: '#a475f9',
        brightCyan: '#0969da',
        brightWhite: '#24292f'
      }
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    try {
      fitAddon.fit()
    } catch (err) {
      console.error(err)
    }

    termRef.current = term
    fitAddonRef.current = fitAddon

    window.api.terminal.start(terminalId, rootPath)
      .then(() => {
        const { cols, rows } = term
        window.api.terminal.resize(terminalId, cols, rows).catch(() => {})
      })
      .catch((err: any) => {
        term.write(`\r\n\x1b[31m[无法启动终端]: ${err}\x1b[0m\r\n`)
      })

    const termDataDisposable = term.onData((data) => {
      window.api.terminal.write(terminalId, data).catch(() => {})
    })

    const termResizeDisposable = term.onResize((size) => {
      window.api.terminal.resize(terminalId, size.cols, size.rows).catch(() => {})
    })

    const unsubscribeOutput = window.api.terminal.onOutput((tId: string, data: string) => {
      if (tId === terminalId) {
        term.write(data)
      }
    })

    const unsubscribeExit = window.api.terminal.onExit((tId: string) => {
      if (tId === terminalId) {
        term.write('\r\n\x1b[31m[系统进程：当前终端 Shell 已退出]\x1b[0m\r\n')
      }
    })

    const timer = setTimeout(() => {
      if (fitAddonRef.current) {
        try {
          fitAddonRef.current.fit()
        } catch (err) {
          console.error(err)
        }
      }
    }, 150)

    if (visible) {
      term.focus()
    }

    return () => {
      clearTimeout(timer)
      termDataDisposable.dispose()
      termResizeDisposable.dispose()
      unsubscribeOutput()
      unsubscribeExit()
      term.dispose()
    }
  }, [terminalId, rootPath])

  return (
    <div
      ref={containerRef}
      className={`terminal-instance-mount ${visible ? 'block' : 'hidden'}`}
    />
  )
}
