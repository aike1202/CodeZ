import type { WorkspaceInfo } from '@shared/types/workspace'
import type { ChatMessage } from '../../../stores/chatStore'

export interface ChatAreaProps {
  messages: ChatMessage[]
  activeSessionId: string | null
  workspace: WorkspaceInfo | null
  panelOpen: boolean
  onPreviewFile?: (filePath: string) => void
  onOpenSettings?: () => void
  onOpenProject?: () => void
}
