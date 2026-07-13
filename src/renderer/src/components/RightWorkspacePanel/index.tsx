import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  ChevronDown,
  FileCode2,
  FileDiff,
  PanelRightClose,
  Plus,
  SquareTerminal,
  X
} from 'lucide-react'
import type { WorkspaceInfo } from '@shared/types/workspace'
import type { ChatMessage, SubAgentRecord } from '../../stores/chatStore'
import type { PreviewTab } from '../../App/hooks/useAppPreview'
import FilePreviewPanel from '../FilePreviewPanel'
import TerminalPanel from '../chat/TerminalPanel'
import { SubAgentLogsPanel } from './SubAgentLogsPanel'
import './RightWorkspacePanel.css'

export const TERMINAL_TAB_ID = 'tool:terminal'
export const SUBAGENT_TAB_ID = 'tool:subagents'

interface RightWorkspacePanelProps {
  previewTabs: PreviewTab[]
  activeTabId: string | null
  terminalOpen: boolean
  subagentLogOpen: boolean
  subAgents: SubAgentRecord[]
  messages: ChatMessage[]
  workspace: WorkspaceInfo
  panelWidth: number
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onOpenTerminal: () => void
  onOpenSubagents: () => void
  onClosePanel: () => void
  onFileClick: (filePath: string, virtualContent?: string) => void
  onDiffClick: (
    filePath: string,
    editInfo: {
      type: 'write' | 'replace'
      targetContent?: string
      replacementContent?: string
      codeContent?: string
    }
  ) => void
}

interface WorkspaceTab {
  id: string
  title: string
  titleDetail: string
  kind: 'file' | 'diff' | 'terminal' | 'subagents'
  closable: boolean
}

export default function RightWorkspacePanel({
  previewTabs,
  activeTabId,
  terminalOpen,
  subagentLogOpen,
  subAgents,
  messages,
  workspace,
  panelWidth,
  onSelectTab,
  onCloseTab,
  onOpenTerminal,
  onOpenSubagents,
  onClosePanel,
  onFileClick,
  onDiffClick
}: RightWorkspacePanelProps): React.ReactElement {
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)

  const tabs = useMemo<WorkspaceTab[]>(() => {
    const fileTabs: WorkspaceTab[] = previewTabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      titleDetail: tab.filePath,
      kind: tab.kind,
      closable: true
    }))
    if (terminalOpen) {
      fileTabs.push({
        id: TERMINAL_TAB_ID,
        title: '终端',
        titleDetail: workspace.rootPath,
        kind: 'terminal',
        closable: true
      })
    }
    if (subagentLogOpen) {
      fileTabs.push({
        id: SUBAGENT_TAB_ID,
        title: '子智能体',
        titleDetail: '当前会话的子智能体执行日志',
        kind: 'subagents',
        closable: true
      })
    }
    return fileTabs
  }, [previewTabs, subagentLogOpen, terminalOpen, workspace.rootPath])

  const resolvedActiveTabId = tabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : tabs[0]?.id ?? null
  const activePreviewTab = previewTabs.find((tab) => tab.id === resolvedActiveTabId) ?? null

  useEffect(() => {
    if (!addMenuOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) setAddMenuOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [addMenuOpen])

  const handleTabKeyDown = (event: React.KeyboardEvent, tabId: string) => {
    const currentIndex = tabs.findIndex((tab) => tab.id === tabId)
    if (currentIndex < 0) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const delta = event.key === 'ArrowLeft' ? -1 : 1
      const nextIndex = (currentIndex + delta + tabs.length) % tabs.length
      onSelectTab(tabs[nextIndex].id)
      requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>(`[data-workspace-tab="${CSS.escape(tabs[nextIndex].id)}"]`)?.focus()
      })
    }
    if (event.key === 'Delete') onCloseTab(tabId)
  }

  const renderTabIcon = (kind: WorkspaceTab['kind']) => {
    if (kind === 'terminal') return <SquareTerminal size={14} aria-hidden="true" />
    if (kind === 'subagents') return <Bot size={14} aria-hidden="true" />
    if (kind === 'diff') return <FileDiff size={14} aria-hidden="true" />
    return <FileCode2 size={14} aria-hidden="true" />
  }

  return (
    <section className="right-workspace-panel" aria-label="右侧工作区">
      <div className="right-workspace-tabbar">
        <div className="right-workspace-tabs" role="tablist" aria-label="已打开的页面">
          {tabs.map((tab) => {
            const isActive = tab.id === resolvedActiveTabId
            return (
              <div
                key={tab.id}
                className={`right-workspace-tab ${isActive ? 'right-workspace-tab--active' : ''}`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  data-workspace-tab={tab.id}
                  className="right-workspace-tab-main"
                  title={tab.titleDetail}
                  onClick={() => onSelectTab(tab.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
                >
                  {renderTabIcon(tab.kind)}
                  <span>{tab.title}</span>
                  {tab.kind === 'subagents' && subAgents.some((agent) => agent.status === 'running') && (
                    <span className="right-workspace-live-dot" aria-label="有子智能体正在运行" />
                  )}
                </button>
                {tab.closable && (
                  <button
                    type="button"
                    className="right-workspace-tab-close"
                    title={`关闭 ${tab.title}`}
                    aria-label={`关闭 ${tab.title}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      onCloseTab(tab.id)
                    }}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                )}
              </div>
            )
          })}
        </div>

        <div className="right-workspace-actions">
          <div className="right-workspace-add" ref={addMenuRef}>
            <button
              type="button"
              className="right-workspace-icon-button"
              title="打开工具页"
              aria-label="打开工具页"
              aria-expanded={addMenuOpen}
              onClick={() => setAddMenuOpen((open) => !open)}
            >
              <Plus size={16} aria-hidden="true" />
              <ChevronDown size={10} aria-hidden="true" />
            </button>
            {addMenuOpen && (
              <div className="right-workspace-add-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onOpenTerminal()
                    setAddMenuOpen(false)
                  }}
                >
                  <SquareTerminal size={15} aria-hidden="true" />
                  终端
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onOpenSubagents()
                    setAddMenuOpen(false)
                  }}
                >
                  <Bot size={15} aria-hidden="true" />
                  子智能体日志
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="right-workspace-icon-button right-workspace-collapse"
            title="隐藏右侧工作区"
            aria-label="隐藏右侧工作区"
            onClick={onClosePanel}
          >
            <PanelRightClose size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="right-workspace-content">
        {activePreviewTab && (
          <div className="right-workspace-pane" role="tabpanel">
            <FilePreviewPanel
              previewPath={activePreviewTab.previewPath}
              previewDiff={activePreviewTab.diff}
              previewLoading={activePreviewTab.loading}
              previewContent={activePreviewTab.content}
              messages={messages}
              hideHeader
              onFileClick={onFileClick}
            />
          </div>
        )}

        {terminalOpen && (
          <div
            className={`right-workspace-pane ${resolvedActiveTabId === TERMINAL_TAB_ID ? '' : 'right-workspace-pane--hidden'}`}
            role="tabpanel"
          >
            <TerminalPanel
              workspaceId={workspace.id}
              rootPath={workspace.rootPath}
              onClose={() => onCloseTab(TERMINAL_TAB_ID)}
              previewPanelWidth={panelWidth}
              layout="side"
              visible={resolvedActiveTabId === TERMINAL_TAB_ID}
            />
          </div>
        )}

        {resolvedActiveTabId === SUBAGENT_TAB_ID && (
          <div className="right-workspace-pane" role="tabpanel">
            <SubAgentLogsPanel
              subAgents={subAgents}
              onFileClick={onFileClick}
              onDiffClick={onDiffClick}
            />
          </div>
        )}
      </div>
    </section>
  )
}
