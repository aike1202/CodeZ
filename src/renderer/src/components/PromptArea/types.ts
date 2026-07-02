import type { WorkspaceInfo } from '@shared/types/workspace'

export interface PromptAreaProps {
  onSend: (message: string, modelName: string) => void
  placeholder?: string
  onOpenSettings?: () => void
  workspace?: WorkspaceInfo | null
}
