import type { WorkspaceInfo } from '@shared/types/workspace'
import type { ChatMessage } from '../../../stores/chatStore'

export interface ChatAreaProps {
  messages: ChatMessage[]
  activeSessionId: string | null
  workspace: WorkspaceInfo | null
  terminalOpen: boolean
  setTerminalOpen: (open: boolean) => void
  terminalHeight: number
  setTerminalHeight: (height: number) => void
  sidebarWidth: number
  previewPanelWidth: number
  panelOpen: boolean
  onPreviewFile?: (filePath: string) => void
  onOpenSettings?: () => void
  onOpenProject?: () => void
}
