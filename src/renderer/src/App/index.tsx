import React, { useState, useEffect, useMemo, useCallback } from 'react'
import Sidebar from '../components/Sidebar'
import TopBar from '../components/TopBar'
import AppLayout from '../components/layout/AppLayout'
import SettingsPage from '../pages/SettingsPage'
import McpReverseRequestApproval from '../components/McpReverseRequestApproval'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { useProviderStore } from '../stores/providerStore'
import { useChatStore } from '../stores/chatStore'
import ExecutionHistoryModal from '../components/modals/ExecutionHistoryModal'
import PlanListModal from '../components/chat/PlanListModal'
import ChatArea from '../components/chat/ChatArea'
import RightWorkspacePanel, {
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
import { desktopApi } from '../shared/desktop'

export default function App(): React.ReactElement {
  return (
    <>
      <ActiveApp />
      <McpReverseRequestApproval />
    </>
  )
}

function ActiveApp(): React.ReactElement {
  const planAvailable = desktopApi.capabilities.plan
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
  const [rightPanelVisible, setRightPanelVisible] = useState(false)
  const [activeRightTabId, setActiveRightTabId] = useState<string | null>(null)
  const [taskModalOpen, setTaskModalOpen] = useState(false)

  const hasRightTabs = previewTabs.length > 0 || terminalOpen
  const panelOpen = rightPanelVisible && hasRightTabs
  const rightTabIds = useMemo(() => [
    ...previewTabs.map((tab) => tab.id),
    ...(terminalOpen ? [TERMINAL_TAB_ID] : [])
  ], [previewTabs, terminalOpen])
  const resolvedActiveRightTabId = rightTabIds.includes(activeRightTabId ?? '')
    ? activeRightTabId
    : rightTabIds[0] ?? null

  useEffect(() => {
    desktopApi.workspace.getRecentProjects().then((p) => useWorkspaceStore.getState().setRecentProjects(p)).catch(() => {})
    loadProviders()
    const cleanupRuntimeStatusListener = desktopApi.chat.onRuntimeStatusChanged(
      useChatStore.getState().applyRuntimeStatus
    )
    void loadSessions().then(() => {
      const sessionIds = useChatStore.getState().sessions.map((session) => session.id)
      return useChatStore.getState().refreshRuntimeStatuses(sessionIds)
    })
    const cleanupPlanStateListener = planAvailable
      ? useChatStore.getState().initPlanStateListener()
      : () => undefined

    const applyTheme = (shouldUseDarkColors: boolean): void => {
      document.documentElement.classList.toggle('dark', shouldUseDarkColors)
    }
    void desktopApi.settings.get()
      .then((settings) => desktopApi.theme.set(settings.appTheme))
      .catch(() => desktopApi.theme.get())
      .then((info) => applyTheme(info.shouldUseDarkColors))
      .catch(() => undefined)
    const cleanupTheme = desktopApi.theme.onUpdated((info) => applyTheme(info.shouldUseDarkColors))
    return () => {
      cleanupTheme()
      cleanupPlanStateListener()
      cleanupRuntimeStatusListener()
    }
  }, [planAvailable])

  useEffect(() => {
    if (!workspace) {
      setTerminalOpen(false)
      setRightPanelVisible(false)
    }
  }, [workspace])

  useEffect(() => {
    if (!activePreviewTabId) return
    setActiveRightTabId(activePreviewTabId)
    setRightPanelVisible(true)
  }, [activePreviewTabId])

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

  const handleSelectRightTab = useCallback((tabId: string) => {
    setActiveRightTabId(tabId)
    if (tabId.startsWith('file:') || tabId.startsWith('diff:')) selectPreviewTab(tabId)
  }, [selectPreviewTab])

  const handleCloseRightTab = useCallback((tabId: string) => {
    if (tabId === TERMINAL_TAB_ID) setTerminalOpen(false)
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
      <>
        <div className="settings-view-wrapper">
          <SettingsPage
            initialTab={settingsTab}
            onBack={() => setCurrentView(hasMessages ? 'chat' : 'home')}
            onCreateFromSkill={handleCreateFromSkill}
          />
        </div>
      </>
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
              messages={messages}
              workspace={workspace}
              panelWidth={previewPanelWidth}
              onSelectTab={handleSelectRightTab}
              onCloseTab={handleCloseRightTab}
              onOpenTerminal={openTerminalTab}
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
        <ExecutionHistoryModal
          workspaceId={workspace.id}
          onClose={() => setTaskModalOpen(false)}
        />
      )}

      {planAvailable ? (
        <PlanListModal
          isOpen={planListModalOpen}
          onClose={() => setPlanListModalOpen(false)}
        />
      ) : null}
    </>
  )
}
