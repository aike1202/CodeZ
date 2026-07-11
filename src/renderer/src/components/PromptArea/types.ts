import type { WorkspaceInfo } from '@shared/types/workspace'
import type { ComposerImageAttachment } from '@shared/types/attachment'

export interface PromptAreaProps {
  onSend: (
    message: string,
    modelName: string,
    attachments: ComposerImageAttachment[]
  ) => Promise<boolean>
  placeholder?: string
  onOpenSettings?: () => void
  workspace?: WorkspaceInfo | null
}
