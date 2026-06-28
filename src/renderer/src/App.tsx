import React, { useState, useCallback, useEffect, useMemo } from 'react'
import Sidebar, { type SidebarProject } from './components/Sidebar'
import TopBar from './components/TopBar'
import AppLayout from './components/layout/AppLayout'
import SettingsPage from './pages/SettingsPage'
import { useWorkspaceStore } from './stores/workspaceStore'
import { useProviderStore } from './stores/providerStore'
import { useChatStore } from './stores/chatStore'
import type { WorkspaceInfo, FileContent } from '@shared/types/workspace'
import TaskHistoryModal from './components/modals/TaskHistoryModal'
import Flex from './components/ui/Flex'
import FilePreviewPanel from './components/FilePreviewPanel'
import ChatArea from './components/chat/ChatArea'
import './styles.css'
import './App.css'

function genId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/* ---------- sidebar project shape ---------- */
function buildSidebarProjects(
  recentProjects: WorkspaceInfo[],
  sessionsMap: Record<string, Array<{ id: string; summary: string; relativeTime: string; isArchived?: boolean; isDeleted?: boolean }>>
): SidebarProject[] {
  return recentProjects.map((p) => ({
    id: p.id,
    name: p.name,
    sessions: (sessionsMap[p.id] || []).map((s) => ({
      id: s.id,
      summary: s.summary,
      relativeTime: s.relativeTime,
      isArchived: s.isArchived,
      isDeleted: s.isDeleted
    }))
  }))
}

/* ========== App ========== */
export default function App(): React.ReactElement {

  /* ---- workspace ---- */
  const recentProjects = useWorkspaceStore((s) => s.recentProjects)
  const setRecentProjects = useWorkspaceStore((s) => s.setRecentProjects)
  const workspace = useWorkspaceStore((s) => s.workspace)

  /* ---- provider ---- */
  const providers = useProviderStore((s) => s.providers)
  const activeProviderId = useProviderStore((s) => s.activeProviderId)
  const loadProviders = useProviderStore((s) => s.loadProviders)

  /* ---- chat ---- */
  const sessions = useChatStore((s) => s.sessions)
  const messages = useChatStore((s) => s.messages)
  const activeSessionId = useChatStore((s) => s.activeSessionId)

  const loadSessions = useChatStore((s) => s.loadSessions)
  const createSession = useChatStore((s) => s.createSession)
  const selectSession = useChatStore((s) => s.selectSession)

  const archiveSession = useChatStore((s) => s.archiveSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const restoreSession = useChatStore((s) => s.restoreSession)

  /* ---- settings panel ---- */
  const [currentView, setCurrentView] = useState<'home' | 'chat' | 'settings'>('home')

  /* ---- init ---- */
  useEffect(() => {
    window.api.workspace.getRecentProjects().then(setRecentProjects).catch(() => {})
    loadProviders()
    loadSessions()
  }, [])



  /* ---- sessions by project ---- */
  const sessionsByProject: Record<string, Array<{ id: string; summary: string; relativeTime: string; isArchived?: boolean; isDeleted?: boolean }>> = {}
  for (const s of sessions) {
    if (!sessionsByProject[s.projectId]) sessionsByProject[s.projectId] = []
    sessionsByProject[s.projectId].push({ id: s.id, summary: s.summary, relativeTime: s.relativeTime, isArchived: s.isArchived, isDeleted: s.isDeleted })
  }

  const sidebarProjects = buildSidebarProjects(recentProjects, sessionsByProject)

  /* ---------- open project ---------- */
  const handleOpenProject = useCallback(async () => {
    const dirPath = await window.api.workspace.openDirectory()
    if (!dirPath) return

    const store = useWorkspaceStore.getState()
    store.setLoading(true)
    try {
      const [fileTree, projectInfo] = await Promise.all([
        window.api.workspace.scanFileTree(dirPath),
        window.api.workspace.detectProject(dirPath)
      ])

      const name = dirPath.split(/[/\\]/).pop() || dirPath
      const ws: WorkspaceInfo = {
        id: genId(),
        rootPath: dirPath,
        name,
        projectType: projectInfo.type,
        openedAt: new Date().toISOString()
      }

      store.setWorkspace(ws)
      store.setFileTree(fileTree)
      store.setProjectInfo(projectInfo)
      await window.api.workspace.addRecentProject(ws)

      const updated = await window.api.workspace.getRecentProjects()
      store.setRecentProjects(updated)

      // 鑷姩鍒涘缓鏂颁細璇?      createSession(ws.id)
    } catch (error) {
      console.error('Failed to open workspace:', error)
    } finally {
      store.setLoading(false)
    }
  }, [createSession])

  /* ---------- open recent project from sidebar ---------- */
  const handleOpenRecentProject = useCallback(async (project: SidebarProject) => {
    const existing = recentProjects.find((p) => p.id === project.id)
    if (!existing) return

    const store = useWorkspaceStore.getState()
    store.setLoading(true)
    try {
      const [fileTree, projectInfo] = await Promise.all([
        window.api.workspace.scanFileTree(existing.rootPath),
        window.api.workspace.detectProject(existing.rootPath)
      ])

      store.setWorkspace(existing)
      store.setFileTree(fileTree)
      store.setProjectInfo(projectInfo)
    } catch (error) {
      console.error('Failed to open recent workspace:', error)
    } finally {
      store.setLoading(false)
    }
  }, [recentProjects])

  /* ---------- rename recent project ---------- */
  const handleRenameProject = useCallback(async (id: string, newName: string) => {
    try {
      await window.api.workspace.renameRecentProject(id, newName)
      const updated = await window.api.workspace.getRecentProjects()
      useWorkspaceStore.getState().setRecentProjects(updated)
      
      const currentWs = useWorkspaceStore.getState().workspace
      if (currentWs && currentWs.id === id) {
        useWorkspaceStore.getState().setWorkspace({
          ...currentWs,
          name: newName
        })
      }
    } catch (error) {
      console.error('Failed to rename project:', error)
    }
  }, [])

  /* ---------- remove recent project ---------- */
  const handleRemoveProject = useCallback(async (id: string) => {
    try {
      await window.api.workspace.removeRecentProject(id)
      const updated = await window.api.workspace.getRecentProjects()
      useWorkspaceStore.getState().setRecentProjects(updated)

      const currentWs = useWorkspaceStore.getState().workspace
      if (currentWs && currentWs.id === id) {
        useWorkspaceStore.getState().setWorkspace(null)
        useWorkspaceStore.getState().setFileTree([])
        useWorkspaceStore.getState().setProjectInfo(null)
      }
    } catch (error) {
      console.error('Failed to remove project:', error)
    }
  }, [])

  /* ---------- show in explorer ---------- */
  const handleShowInExplorer = useCallback(async (id: string) => {
    const proj = recentProjects.find((p) => p.id === id)
    if (proj) {
      await window.api.workspace.openInExplorer(proj.rootPath)
    }
  }, [recentProjects])

  /* ---------- select a session ---------- */
  const handleSelectSession = useCallback((sessionId: string) => {
    if (sessionId.endsWith('__new')) {
      const ws = useWorkspaceStore.getState().workspace
      if (!ws) return
      createSession(ws.id)
      return
    }

    if (sessionId === '__new_detached') {
      const ws = useWorkspaceStore.getState().workspace
      if (!ws) return
      createSession(ws.id)
      return
    }

    selectSession(sessionId)

    // 智能联动：如果当前没有打开项目，或者打开的项目不匹配该会话的项目ID，自动帮用户切换/加载该项目
    const session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
    if (session && session.projectId) {
      const currentWs = useWorkspaceStore.getState().workspace
      if (!currentWs || currentWs.id !== session.projectId) {
        const targetProj = recentProjects.find((p) => p.id === session.projectId)
        if (targetProj) {
          handleOpenRecentProject({ id: targetProj.id, name: targetProj.name, sessions: [] })
        }
      }
    }
  }, [createSession, selectSession, recentProjects, handleOpenRecentProject])

  /* ---------- file preview panel ---------- */
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState<FileContent | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewDiff, setPreviewDiff] = useState<{
    filePath: string
    type: 'write' | 'replace'
    targetContent?: string
    replacementContent?: string
    codeContent?: string
  } | null>(null)
  
  // 左侧边栏及右侧面板宽度状态
  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [previewPanelWidth, setPreviewPanelWidth] = useState(480)

  // 终端显示及高度状态
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalHeight, setTerminalHeight] = useState(200)

  // 模态框状态
  const [taskModalOpen, setTaskModalOpen] = useState(false)

  const panelOpen = previewPath !== null || previewDiff !== null

  // 褰?workspace 鍙樺姩涓斾负绌烘椂锛屽叧闂粓绔獥鍙?
  useEffect(() => {
    if (!workspace) {
      setTerminalOpen(false)
    }
  }, [workspace])

  // 闄愬埗渚ц竟鏍忔渶澶у搴︼紝淇濊瘉涓棿鑱婂ぉ鍖哄搴﹁嚦灏戜负 300px
  const maxSidebarWidth = useMemo(() => {
    const totalWidth = typeof window !== 'undefined' ? window.innerWidth : 1200
    return Math.max(200, totalWidth - 300 - (panelOpen ? previewPanelWidth : 0))
  }, [panelOpen, previewPanelWidth])

  // 褰撶獥鍙ｅぇ灏忔敼鍙樻垨鍖哄煙澶у皬鏀瑰彉鏃讹紝鑷姩绾︽潫瀹藉害锛岄槻姝㈣秴鍑虹獥鍙ｅ鑷存爣棰樻爮绛夋埅鏂?
  useEffect(() => {
    const handleResize = () => {
      const totalWidth = window.innerWidth
      const minChatWidth = 300
      const available = totalWidth - minChatWidth

      if (panelOpen) {
        if (sidebarWidth + previewPanelWidth > available) {
          let newSidebarWidth = sidebarWidth
          if (newSidebarWidth > 260) {
            newSidebarWidth = 260
          }
          let newPreviewWidth = Math.max(320, available - newSidebarWidth)
          newSidebarWidth = Math.max(200, available - newPreviewWidth)
          
          if (newSidebarWidth !== sidebarWidth) setSidebarWidth(newSidebarWidth)
          if (newPreviewWidth !== previewPanelWidth) setPreviewPanelWidth(newPreviewWidth)
        }
      } else {
        if (sidebarWidth > available) {
          const newSidebarWidth = Math.max(200, available)
          if (newSidebarWidth !== sidebarWidth) setSidebarWidth(newSidebarWidth)
        }
      }
    }

    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [panelOpen, sidebarWidth, previewPanelWidth])

  const handleFileClick = useCallback(async (filePath: string, virtualContent?: string) => {
    setPreviewDiff(null) // 娓呯┖ Diff 鐘舵€佷互闃叉贩娣?
    const ws = useWorkspaceStore.getState().workspace
    if (!ws) return

    const cleanPath = filePath.replace(/(:\d+)$/, '')
    setPreviewPath(filePath)
    setPreviewLoading(true)
    setPreviewContent(null)

    if (virtualContent !== undefined) {
      setPreviewContent({
        path: filePath,
        content: virtualContent,
        truncated: false,
        totalLines: virtualContent.split('\n').length
      })
      setPreviewLoading(false)
      return
    }

    try {
      const content = await window.api.workspace.readFile(cleanPath, ws.rootPath)
      setPreviewContent(content)
    } catch {
      setPreviewContent({
        path: cleanPath,
        content: `鏃犳硶璇诲彇鏂囦欢锛?{cleanPath}`,
        truncated: false,
        totalLines: 0
      })
    } finally {
      setPreviewLoading(false)
    }
  }, [])

  const handleDiffClick = useCallback((
    filePath: string,
    editInfo: {
      type: 'write' | 'replace'
      targetContent?: string
      replacementContent?: string
      codeContent?: string
    }
  ) => {
    setPreviewPath(null) // 鍏抽棴鏅€氭枃浠堕瑙?    setPreviewContent(null)
    setPreviewDiff({
      filePath,
      ...editInfo
    })
  }, [])

  /* ---------- render ---------- */
  const hasMessages = messages.length > 0
  const sideTitle = previewPath || (previewDiff ? `Diff: ${previewDiff.filePath}` : '')

  // 设置页全屏覆盖
  if (currentView === 'settings') {
    return (
      <div className="settings-view-wrapper">
        <SettingsPage onBack={() => setCurrentView(hasMessages ? 'chat' : 'home')} />
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
            onOpenSettings={() => setCurrentView('settings')}
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
        rightPanel={panelOpen ? (
          <FilePreviewPanel
            previewPath={previewPath}
            previewDiff={previewDiff}
            previewLoading={previewLoading}
            previewContent={previewContent}
            messages={messages}
            onClose={() => {
              setPreviewPath(null)
              setPreviewDiff(null)
            }}
            onFileClick={handleFileClick}
          />
        ) : undefined}
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
            setCurrentView={setCurrentView}
          />
        }
      />

      {/* 妯℃€佹 */}
      {taskModalOpen && workspace && (
        <TaskHistoryModal
          workspaceId={workspace.id}
          onClose={() => setTaskModalOpen(false)}
        />
      )}
    </>
  )
}




