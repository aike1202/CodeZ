import React, { useEffect, useRef, useState } from 'react'
import Button from '../../ui/Button'
import Flex from '../../ui/Flex'
import Stack from '../../ui/Stack'
import IconClose from '../../icons/IconClose'
import IconPlus from '../../icons/IconPlus'
import { RotateCw, SquareTerminal, Trash2 } from 'lucide-react'
import './TerminalPanel.css'
import type { TerminalPanelProps, TerminalTab } from './types'
import { TerminalInstance } from './components/TerminalInstance'
import { desktopApi } from '../../../shared/desktop'

let terminalInstanceSequence = 0

function createTerminalId(): string {
  terminalInstanceSequence = (terminalInstanceSequence + 1) >>> 0
  return `term-${Date.now().toString(36)}-${terminalInstanceSequence.toString(36)}`
}

export default function TerminalPanel({
  workspaceId,
  rootPath,
  height,
  setHeight,
  onClose,
  sidebarWidth,
  previewPanelWidth,
  layout = 'bottom',
  visible = true
}: TerminalPanelProps): React.ReactElement {
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [clearTriggers, setClearTriggers] = useState<Record<string, number>>({})
  const [resetTriggers, setResetTriggers] = useState<Record<string, number>>({})
  const tabsRef = useRef<TerminalTab[]>([])

  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  useEffect(() => {
    const previousTabs = tabsRef.current
    for (const tab of previousTabs) {
      void desktopApi.terminal.kill(tab.id).catch(() => undefined)
    }

    const firstTab = { id: createTerminalId(), name: '终端 1' }
    setTabs([firstTab])
    setActiveTabId(firstTab.id)
    setClearTriggers({})
    setResetTriggers({})
  }, [workspaceId])

  useEffect(() => () => {
    for (const tab of tabsRef.current) {
      void desktopApi.terminal.kill(tab.id).catch(() => undefined)
    }
  }, [])

  const handleDragMouseDown = (e: React.MouseEvent) => {
    if (layout === 'side' || !setHeight) return
    e.preventDefault()
    const startY = e.clientY
    const startHeight = height ?? 200

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
    const newId = createTerminalId()
    setTabs((current) => [...current, { id: newId, name: `终端 ${current.length + 1}` }])
    setActiveTabId(newId)
  }

  const handleCloseTab = async (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation()
    await desktopApi.terminal.kill(tabId)

    const newTabs = tabs.filter((t) => t.id !== tabId)
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
      setClearTriggers((prev) => ({ ...prev, [activeTabId]: (prev[activeTabId] || 0) + 1 }))
    }
  }

  const handleReset = () => {
    if (activeTabId) {
      setResetTriggers((prev) => ({ ...prev, [activeTabId]: (prev[activeTabId] || 0) + 1 }))
    }
  }

  return (
    <Stack
      className={`terminal-panel ${layout === 'side' ? 'terminal-panel--side' : ''}`}
      style={{ height: layout === 'side' ? '100%' : height }}
    >
      {layout === 'bottom' && <div className="terminal-drag-bar" onMouseDown={handleDragMouseDown} />}

      <Flex align="center" justify="between" className="terminal-header">
        <Flex align="center" gap={1} className="terminal-header-left">
          <span className="terminal-header-title">
            <SquareTerminal size={13} aria-hidden="true" />
            会话
          </span>

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
            aria-label="清除当前终端屏幕"
          >
            <Trash2 size={14} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="none"
            onClick={handleReset}
            className="terminal-action-btn"
            title="重置当前激活终端会话"
            aria-label="重置当前终端会话"
          >
            <RotateCw size={14} aria-hidden="true" />
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
            height={height ?? 0}
            panelVisible={visible}
            clearTrigger={clearTriggers[tab.id] || 0}
            resetTrigger={resetTriggers[tab.id] || 0}
          />
        ))}
      </div>
    </Stack>
  )
}

export type { TerminalPanelProps } from './types'
