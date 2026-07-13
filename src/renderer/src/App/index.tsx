import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import Sidebar from '../components/Sidebar'
import TopBar from '../components/TopBar'
import AppLayout from '../components/layout/AppLayout'
import SettingsPage from '../pages/SettingsPage'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { useProviderStore } from '../stores/providerStore'
import { useChatStore } from '../stores/chatStore'
import TaskHistoryModal from '../components/modals/TaskHistoryModal'
import PlanListModal from '../components/chat/PlanListModal'
import ChatArea from '../components/chat/ChatArea'
import RightWorkspacePanel, {
  SUBAGENT_TAB_ID,
  TERMINAL_TAB_ID
} from '../components/RightWorkspacePanel'
import '../styles.css'
import '../App.css'

import { useAppWorkspace } from './hooks/useAppWorkspace'
import {
  getDiffPreviewTabId,
  getFilePreviewTabId,
  useAppPreview
} from './hooks/useAppPreview'

export default function App(): React.ReactElement {
  const loadProviders = useProviderStore((s) => s.loadProviders)
  const messages = useChatStore((s) => s.messages)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const loadSessions = useChatStore((s) => s.loadSessions)
  const archiveSession = useChatStore((s) => s.archiveSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const restoreSession = useChatStore((s) => s.restoreSession)
  const planListModalOpen = useChatStore((s) => s.planListModalOpen)
  const setPlanListModalOpen = useChatStore((s) => s.setPlanListModalOpen)
  const createSession = useChatStore((s) => s.createSession)
  const setPendingPrompt = useChatStore((s) => s.setPendingPrompt)

  const {
    workspace,
    sidebarProjects,
    handleOpenProject,
    handleOpenRecentProject,
    handleRenameProject,
    handleRemoveProject,
    handleShowInExplorer,
    handleSelectSession
  } = useAppWorkspace()

  const {
    previewTabs,
    activePreviewTabId,
    handleFileClick: loadFilePreview,
    handleDiffClick: loadDiffPreview,
    closePreview,
    selectPreviewTab
  } = useAppPreview()

  const [currentView, setCurrentView] = useState<'home' | 'chat' | 'settings'>('home')
  const [settingsTab, setSettingsTab] = useState('general')

  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [previewPanelWidth, setPreviewPanelWidth] = useState(480)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [subagentLogOpen, setSubagentLogOpen] = useState(false)
  const [rightPanelVisible, setRightPanelVisible] = useState(false)
  const [activeRightTabId, setActiveRightTabId] = useState<string | null>(null)
  const [taskModalOpen, setTaskModalOpen] = useState(false)
  const autoOpenedSubagentSessionRef = useRef<string | null>(null)

  const subAgents = useMemo(
    () => messages.flatMap((message) => message.subAgents ?? []),
    [messages]
  )
  const hasRightTabs = previewTabs.length > 0 || terminalOpen || subagentLogOpen
  const panelOpen = rightPanelVisible && hasRightTabs
  const rightTabIds = useMemo(() => [
    ...previewTabs.map((tab) => tab.id),
    ...(terminalOpen ? [TERMINAL_TAB_ID] : []),
    ...(subagentLogOpen ? [SUBAGENT_TAB_ID] : [])
  ], [previewTabs, subagentLogOpen, terminalOpen])
  const resolvedActiveRightTabId = rightTabIds.includes(activeRightTabId ?? '')
    ? activeRightTabId
    : rightTabIds[0] ?? null

  useEffect(() => {
    window.api.workspace.getRecentProjects().then((p) => useWorkspaceStore.getState().setRecentProjects(p)).catch(() => {})
    loadProviders()
    const cleanupRuntimeStatusListener = window.api.chat.onRuntimeStatusChanged(
      useChatStore.getState().applyRuntimeStatus
    )
    void loadSessions().then(() => {
      const sessionIds = useChatStore.getState().sessions.map((session) => session.id)
      return useChatStore.getState().refreshRuntimeStatuses(sessionIds)
    })
    const cleanupPlanStateListener = useChatStore.getState().initPlanStateListener()

    if (window.api?.theme) {
      window.api.theme.get().then((info) => {
        if (info.shouldUseDarkColors) document.documentElement.classList.add('dark')
        else document.documentElement.classList.remove('dark')
      })
      const cleanupTheme = window.api.theme.onUpdated((info) => {
        if (info.shouldUseDarkColors) document.documentElement.classList.add('dark')
        else document.documentElement.classList.remove('dark')
      })
      return () => {
        cleanupTheme()
        cleanupPlanStateListener()
        cleanupRuntimeStatusListener()
      }
    }
    return () => {
      cleanupPlanStateListener()
      cleanupRuntimeStatusListener()
    }
  }, [])

  useEffect(() => {
    if (!workspace) {
      setTerminalOpen(false)
      setSubagentLogOpen(false)
      setRightPanelVisible(false)
    }
  }, [workspace])

  useEffect(() => {
    if (!activePreviewTabId) return
    setActiveRightTabId(activePreviewTabId)
    setRightPanelVisible(true)
  }, [activePreviewTabId])

  useEffect(() => {
    if (!activeSessionId || subAgents.length === 0) return
    if (autoOpenedSubagentSessionRef.current === activeSessionId) return
    autoOpenedSubagentSessionRef.current = activeSessionId
    setSubagentLogOpen(true)
    setRightPanelVisible(true)
    setActiveRightTabId((current) => current ?? SUBAGENT_TAB_ID)
  }, [activeSessionId, subAgents.length])

  const maxSidebarWidth = useMemo(() => {
    const totalWidth = typeof window !== 'undefined' ? window.innerWidth : 1200
    return Math.max(200, totalWidth - 300 - (panelOpen ? previewPanelWidth : 0))
  }, [panelOpen, previewPanelWidth])

  const hasMessages = messages.length > 0

  const handleFileClick = useCallback(async (filePath: string, virtualContent?: string) => {
    setActiveRightTabId(getFilePreviewTabId(filePath))
    setRightPanelVisible(true)
    await loadFilePreview(filePath, virtualContent)
  }, [loadFilePreview])

  const handleDiffClick = useCallback((
    filePath: string,
    editInfo: {
      type: 'write' | 'replace'
      targetContent?: string
      replacementContent?: string
      codeContent?: string
    }
  ) => {
    setActiveRightTabId(getDiffPreviewTabId(filePath))
    setRightPanelVisible(true)
    loadDiffPreview(filePath, editInfo)
  }, [loadDiffPreview])

  const openTerminalTab = useCallback(() => {
    if (!workspace) return
    setTerminalOpen(true)
    setRightPanelVisible(true)
    setActiveRightTabId(TERMINAL_TAB_ID)
  }, [workspace])

  const openSubagentTab = useCallback(() => {
    if (!workspace) return
    setSubagentLogOpen(true)
    setRightPanelVisible(true)
    setActiveRightTabId(SUBAGENT_TAB_ID)
  }, [workspace])

  const handleSelectRightTab = useCallback((tabId: string) => {
    setActiveRightTabId(tabId)
    if (tabId.startsWith('file:') || tabId.startsWith('diff:')) selectPreviewTab(tabId)
  }, [selectPreviewTab])

  const handleCloseRightTab = useCallback((tabId: string) => {
    if (tabId === TERMINAL_TAB_ID) setTerminalOpen(false)
    else if (tabId === SUBAGENT_TAB_ID) setSubagentLogOpen(false)
    else closePreview(tabId)
    setActiveRightTabId((current) => (current === tabId ? null : current))
  }, [closePreview])

  const handleCreateFromSkill = async (triggerName: string, promptSuffix: string) => {
    let ws = useWorkspaceStore.getState().workspace

    // 无工作区：自动打开"最近打开的项目"里的第一个
    if (!ws) {
      const recent = useWorkspaceStore.getState().recentProjects
      if (recent.length > 0) {
        await handleOpenRecentProject({ id: recent[0].id, name: recent[0].name, sessions: [] })
        ws = useWorkspaceStore.getState().workspace
      }
    }

    // 预填提示词（技能用胶囊格式 [$name](path)，与从菜单选技能时一致）
    setPendingPrompt({
      text: `[$${triggerName}](${triggerName}) ${promptSuffix}`,
      attachments: []
    })

    if (ws) {
      createSession(ws.id)
      setCurrentView('chat')
    } else {
      // 连最近项目都没有：回主页，让用户先打开一个项目
      setCurrentView('home')
    }
  }

  if (currentView === 'settings') {
    return (
      <div className="settings-view-wrapper">
        <SettingsPage
          initialTab={settingsTab}
          onBack={() => setCurrentView(hasMessages ? 'chat' : 'home')}
          onCreateFromSkill={handleCreateFromSkill}
        />
      </div>
    )
  }

  return (
    <>
      <AppLayout
        className="app-main-layout"
        sidebarWidth={sidebarWidth}
        onSidebarWidthChange={setSidebarWidth}
        maxSidebarWidth={maxSidebarWidth}
        rightPanelWidth={previewPanelWidth}
        onRightPanelWidthChange={setPreviewPanelWidth}
        sidebar={
          <Sidebar
            projects={sidebarProjects}
            activeSessionId={activeSessionId}
            activeProjectId={workspace?.id}
            onSelectSession={handleSelectSession}
            onArchiveSession={archiveSession}
            onDeleteSession={deleteSession}
            onRestoreSession={restoreSession}
            onSelectProject={handleOpenRecentProject}
            onOpenProject={handleOpenProject}
            onShowInExplorer={handleShowInExplorer}
            onRenameProject={handleRenameProject}
            onRemoveProject={handleRemoveProject}
            onOpenSettings={() => {
              setSettingsTab('general')
              setCurrentView('settings')
            }}
          />
        }
        topbar={
          <TopBar
            onOpenProject={handleOpenProject}
            terminalOpen={panelOpen && resolvedActiveRightTabId === TERMINAL_TAB_ID}
            onToggleTerminal={() => {
              if (panelOpen && resolvedActiveRightTabId === TERMINAL_TAB_ID) {
                handleCloseRightTab(TERMINAL_TAB_ID)
              } else {
                openTerminalTab()
              }
            }}
            subagentLogOpen={panelOpen && resolvedActiveRightTabId === SUBAGENT_TAB_ID}
            onToggleSubagentLogs={() => {
              if (panelOpen && resolvedActiveRightTabId === SUBAGENT_TAB_ID) {
                handleCloseRightTab(SUBAGENT_TAB_ID)
              } else {
                openSubagentTab()
              }
            }}
            hasSubagentLogs={subAgents.length > 0}
            onOpenTasks={() => setTaskModalOpen(true)}
            hasWorkspace={!!workspace}
          />
        }
        rightPanel={
          panelOpen && workspace ? (
            <RightWorkspacePanel
              previewTabs={previewTabs}
              activeTabId={resolvedActiveRightTabId}
              terminalOpen={terminalOpen}
              subagentLogOpen={subagentLogOpen}
              subAgents={subAgents}
              messages={messages}
              workspace={workspace}
              panelWidth={previewPanelWidth}
              onSelectTab={handleSelectRightTab}
              onCloseTab={handleCloseRightTab}
              onOpenTerminal={openTerminalTab}
              onOpenSubagents={openSubagentTab}
              onClosePanel={() => setRightPanelVisible(false)}
              onFileClick={handleFileClick}
              onDiffClick={handleDiffClick}
            />
          ) : undefined
        }
        chatArea={
          <ChatArea
            messages={messages}
            activeSessionId={activeSessionId}
            workspace={workspace}
            panelOpen={panelOpen}
            handleFileClick={handleFileClick}
            handleDiffClick={handleDiffClick}
            handleOpenRecentProject={handleOpenRecentProject}
            onOpenSettings={(tab?: string) => {
              if (tab) setSettingsTab(tab)
              setCurrentView('settings')
            }}
          />
        }
      />

      {taskModalOpen && workspace && (
        <TaskHistoryModal
          workspaceId={workspace.id}
          onClose={() => setTaskModalOpen(false)}
        />
      )}

      <PlanListModal
        isOpen={planListModalOpen}
        onClose={() => setPlanListModalOpen(false)}
      />
    </>
  )
}
