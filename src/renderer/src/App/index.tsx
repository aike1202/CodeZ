import React, { useState, useEffect, useMemo } from 'react'
import Sidebar from '../components/Sidebar'
import TopBar from '../components/TopBar'
import AppLayout from '../components/layout/AppLayout'
import SettingsPage from '../pages/SettingsPage'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { useProviderStore } from '../stores/providerStore'
import { useChatStore } from '../stores/chatStore'
import TaskHistoryModal from '../components/modals/TaskHistoryModal'
import PlanListModal from '../components/chat/PlanListModal'
import FilePreviewPanel from '../components/FilePreviewPanel'
import ChatArea from '../components/chat/ChatArea'
import '../styles.css'
import '../App.css'

import { useAppWorkspace } from './hooks/useAppWorkspace'
import { useAppPreview } from './hooks/useAppPreview'

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
    previewPath,
    previewContent,
    previewLoading,
    previewDiff,
    panelOpen,
    handleFileClick,
    handleDiffClick,
    closePreview
  } = useAppPreview()

  const [currentView, setCurrentView] = useState<'home' | 'chat' | 'settings'>('home')
  const [settingsTab, setSettingsTab] = useState('general')

  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [previewPanelWidth, setPreviewPanelWidth] = useState(480)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalHeight, setTerminalHeight] = useState(200)
  const [taskModalOpen, setTaskModalOpen] = useState(false)

  useEffect(() => {
    window.api.workspace.getRecentProjects().then((p) => useWorkspaceStore.getState().setRecentProjects(p)).catch(() => {})
    loadProviders()
    loadSessions()
    useChatStore.getState().initPlanStateListener()

    if (window.api?.theme) {
      window.api.theme.get().then((info) => {
        if (info.shouldUseDarkColors) document.documentElement.classList.add('dark')
        else document.documentElement.classList.remove('dark')
      })
      const cleanupTheme = window.api.theme.onUpdated((info) => {
        if (info.shouldUseDarkColors) document.documentElement.classList.add('dark')
        else document.documentElement.classList.remove('dark')
      })
      return () => cleanupTheme()
    }
    return undefined
  }, [])

  useEffect(() => {
    if (!workspace) setTerminalOpen(false)
  }, [workspace])

  const maxSidebarWidth = useMemo(() => {
    const totalWidth = typeof window !== 'undefined' ? window.innerWidth : 1200
    return Math.max(200, totalWidth - 300 - (panelOpen ? previewPanelWidth : 0))
  }, [panelOpen, previewPanelWidth])

  const hasMessages = messages.length > 0

  const handleCreateFromSkill = async (triggerName: string, promptSuffix: string) => {
    let ws = useWorkspaceStore.getState().workspace
    if (!ws) {
      // 无工作区：先让用户选择/打开一个项目（内部会建会话），再预填提示词
      await handleOpenProject()
      ws = useWorkspaceStore.getState().workspace
      if (!ws) return // 用户取消了选择
    } else {
      createSession(ws.id)
    }
    setPendingPrompt(`/${triggerName} ${promptSuffix}`)
    setCurrentView('chat')
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
            terminalOpen={terminalOpen}
            onToggleTerminal={() => setTerminalOpen(!terminalOpen)}
            onOpenTasks={() => setTaskModalOpen(true)}
            hasWorkspace={!!workspace}
          />
        }
        rightPanel={
          panelOpen ? (
            <FilePreviewPanel
              previewPath={previewPath}
              previewDiff={previewDiff}
              previewLoading={previewLoading}
              previewContent={previewContent}
              messages={messages}
              onClose={closePreview}
              onFileClick={handleFileClick}
            />
          ) : undefined
        }
        chatArea={
          <ChatArea
            messages={messages}
            activeSessionId={activeSessionId}
            workspace={workspace}
            terminalOpen={terminalOpen}
            setTerminalOpen={setTerminalOpen}
            terminalHeight={terminalHeight}
            setTerminalHeight={setTerminalHeight}
            sidebarWidth={sidebarWidth}
            previewPanelWidth={previewPanelWidth}
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
