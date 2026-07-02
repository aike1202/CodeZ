import { useCallback } from 'react'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useChatStore } from '../../stores/chatStore'
import type { WorkspaceInfo } from '@shared/types/workspace'
import type { SidebarProject } from '../../components/Sidebar'

function genId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function useAppWorkspace() {
  const recentProjects = useWorkspaceStore((s: any) => s.recentProjects)
  const workspace = useWorkspaceStore((s: any) => s.workspace)
  const sessions = useChatStore((s: any) => s.sessions)
  const createSession = useChatStore((s: any) => s.createSession)
  const selectSession = useChatStore((s: any) => s.selectSession)

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

      createSession(ws.id)
    } catch (error) {
      console.error('Failed to open workspace:', error)
    } finally {
      store.setLoading(false)
    }
  }, [createSession])

  const handleOpenRecentProject = useCallback(
    async (project: SidebarProject) => {
      const existing = recentProjects.find((p: any) => p.id === project.id)
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
    },
    [recentProjects]
  )

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

  const handleShowInExplorer = useCallback(
    async (id: string) => {
      const proj = recentProjects.find((p: any) => p.id === id)
      if (proj) {
        await window.api.workspace.openInExplorer(proj.rootPath)
      }
    },
    [recentProjects]
  )

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      if (sessionId.endsWith('__new') || sessionId === '__new_detached') {
        const ws = useWorkspaceStore.getState().workspace
        if (!ws) return
        createSession(ws.id)
        return
      }

      selectSession(sessionId)

      const session = useChatStore.getState().sessions.find((s: any) => s.id === sessionId)
      if (session && session.projectId) {
        const currentWs = useWorkspaceStore.getState().workspace
        if (!currentWs || currentWs.id !== session.projectId) {
          const targetProj = recentProjects.find((p: any) => p.id === session.projectId)
          if (targetProj) {
            handleOpenRecentProject({ id: targetProj.id, name: targetProj.name, sessions: [] })
          }
        }
      }
    },
    [createSession, selectSession, recentProjects, handleOpenRecentProject]
  )

  const sessionsByProject: Record<
    string,
    Array<{ id: string; summary: string; relativeTime: string; isArchived?: boolean; isDeleted?: boolean }>
  > = {}
  for (const s of sessions) {
    if (!sessionsByProject[s.projectId]) sessionsByProject[s.projectId] = []
    sessionsByProject[s.projectId].push({
      id: s.id,
      summary: s.summary,
      relativeTime: s.relativeTime,
      isArchived: s.isArchived,
      isDeleted: s.isDeleted
    })
  }

  const sidebarProjects: SidebarProject[] = recentProjects.map((p: any) => ({
    id: p.id,
    name: p.name,
    sessions: (sessionsByProject[p.id] || []).map((s) => ({
      id: s.id,
      summary: s.summary,
      relativeTime: s.relativeTime,
      isArchived: s.isArchived,
      isDeleted: s.isDeleted
    }))
  }))

  return {
    recentProjects,
    workspace,
    sidebarProjects,
    handleOpenProject,
    handleOpenRecentProject,
    handleRenameProject,
    handleRemoveProject,
    handleShowInExplorer,
    handleSelectSession
  }
}
