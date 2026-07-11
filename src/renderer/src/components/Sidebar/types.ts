import type { SessionListStatus } from '../../App/hooks/sessionListStatus'

export interface SidebarSession {
  id: string
  summary: string
  relativeTime: string
  isArchived?: boolean
  isDeleted?: boolean
  status: SessionListStatus
}

export interface SidebarProject {
  id: string
  name: string
  sessions: SidebarSession[]
}

export interface SidebarProps {
  projects: SidebarProject[]
  activeSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onArchiveSession?: (sessionId: string, archive: boolean) => void
  onDeleteSession?: (sessionId: string) => void
  onRestoreSession?: (sessionId: string) => void
  onSelectProject: (project: SidebarProject) => void
  onOpenProject: () => void
  activeProjectId?: string
  onShowInExplorer?: (projectId: string) => void
  onRenameProject?: (projectId: string, newName: string) => void
  onRemoveProject?: (projectId: string) => void
  onOpenSettings?: () => void
}
