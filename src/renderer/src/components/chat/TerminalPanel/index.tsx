import React, { useState, useEffect } from 'react'
import Button from '../../ui/Button'
import Flex from '../../ui/Flex'
import Stack from '../../ui/Stack'
import IconClose from '../../icons/IconClose'
import IconPlus from '../../icons/IconPlus'
import './TerminalPanel.css'
import type { TerminalPanelProps, TerminalTab } from './types'
import { TerminalInstance } from './components/TerminalInstance'

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
    <Stack className="terminal-panel" style={{ height }}>
      <div className="terminal-drag-bar" onMouseDown={handleDragMouseDown} />

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

export type { TerminalPanelProps } from './types'
