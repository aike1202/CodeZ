export interface WorkspaceInfo {
  id: string
  rootPath: string
  name: string
  projectType: string
  openedAt: string
  permissionMode?: 'ask' | 'auto-approve-safe' | 'full-access'
}

export interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileTreeNode[]
  size?: number
  extension?: string
}

export interface FileContent {
  path: string
  content: string
  truncated: boolean
  totalLines: number
}

export interface ProjectInfo {
  type: string
  framework?: string
  packageManager?: string
}
