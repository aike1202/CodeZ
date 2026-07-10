import { create } from 'zustand'
import type { FileTreeNode, FileContent, ProjectInfo, WorkspaceInfo } from '@shared/types/workspace'
import type { PermissionMode } from '@shared/types/permission'
import { DEFAULT_PERMISSION_MODE } from '@shared/types/permission'

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
  permissionMode: PermissionMode

  setView: (view: 'home' | 'workspace') => void
  setWorkspace: (ws: WorkspaceInfo | null) => void
  setFileTree: (tree: FileTreeNode[]) => void
  setProjectInfo: (info: ProjectInfo | null) => void
  setSelectedFile: (path: string | null) => void
  setFileContent: (content: FileContent | null) => void
  setRecentProjects: (projects: WorkspaceInfo[]) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  loadPermissionMode: (rootPath: string) => Promise<void>
  setPermissionMode: (mode: PermissionMode) => Promise<void>
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
  permissionMode: DEFAULT_PERMISSION_MODE,

  setView: (view) => set({ currentView: view }),
  setWorkspace: (ws) => {
    set({ workspace: ws, permissionMode: DEFAULT_PERMISSION_MODE })
    if (ws && typeof window !== 'undefined') void get().loadPermissionMode(ws.rootPath)
  },
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
  loadPermissionMode: async (rootPath) => {
    try {
      const permissionMode = await window.api.permission.getMode(rootPath)
      if (get().workspace?.rootPath === rootPath) set({ permissionMode })
    } catch {
      if (get().workspace?.rootPath === rootPath) set({ permissionMode: DEFAULT_PERMISSION_MODE })
    }
  },
  setPermissionMode: async (permissionMode) => {
    const rootPath = get().workspace?.rootPath
    if (!rootPath) return
    const previous = get().permissionMode
    set({ permissionMode })
    try {
      await window.api.permission.setMode(rootPath, permissionMode)
    } catch {
      set({ permissionMode: previous })
    }
  }
}))
