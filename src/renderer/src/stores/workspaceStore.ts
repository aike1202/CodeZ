import { create } from 'zustand'
import type { FileTreeNode, FileContent, ProjectInfo, WorkspaceInfo } from '@shared/types/workspace'

interface WorkspaceState {
  currentView: 'home' | 'workspace'
  workspace: WorkspaceInfo | null
  fileTree: FileTreeNode[]
  projectInfo: ProjectInfo | null
  selectedFilePath: string | null
  fileContent: FileContent | null
  recentProjects: WorkspaceInfo[]
  validFiles: Set<string>
  loading: boolean
  error: string | null

  setView: (view: 'home' | 'workspace') => void
  setWorkspace: (ws: WorkspaceInfo | null) => void
  setFileTree: (tree: FileTreeNode[]) => void
  setProjectInfo: (info: ProjectInfo | null) => void
  setSelectedFile: (path: string | null) => void
  setFileContent: (content: FileContent | null) => void
  setRecentProjects: (projects: WorkspaceInfo[]) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  setPermissionMode: (mode: 'ask' | 'auto-approve-safe' | 'full-access') => Promise<void>
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  currentView: 'home',
  workspace: null,
  fileTree: [],
  projectInfo: null,
  selectedFilePath: null,
  fileContent: null,
  recentProjects: [],
  validFiles: new Set(),
  loading: false,
  error: null,

  setView: (view) => set({ currentView: view }),
  setWorkspace: (ws) => set({ workspace: ws }),
  setFileTree: (tree) => {
    const valid = new Set<string>()
    const traverse = (nodes: FileTreeNode[]) => {
      nodes.forEach(n => {
        if (n.type === 'file') {
          valid.add(n.name)
          valid.add(n.path)
        }
        if (n.children) traverse(n.children)
      })
    }
    traverse(tree)
    set({ fileTree: tree, validFiles: valid })
  },
  setProjectInfo: (info) => set({ projectInfo: info }),
  setSelectedFile: (path) => set({ selectedFilePath: path }),
  setFileContent: (content) => set({ fileContent: content }),
  setRecentProjects: (projects) => set({ recentProjects: projects }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setPermissionMode: async (mode) => {
    const currentWorkspace = get().workspace
    if (!currentWorkspace) return
    const updated = { ...currentWorkspace, permissionMode: mode }
    // @ts-ignore
    if (window.api?.workspace?.updateProject) {
      // @ts-ignore
      await window.api.workspace.updateProject(updated)
    }
    set({ workspace: updated })
  }
}))
