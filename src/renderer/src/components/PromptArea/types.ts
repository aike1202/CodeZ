import type { WorkspaceInfo } from '@shared/types/workspace'
import type { ComposerImageAttachment } from '@shared/types/attachment'
import type { QueuedPrompt } from '@shared/types/queuedPrompt'

export interface PromptAreaProps {
  onSend: (
    message: string,
    modelName: string,
    attachments: ComposerImageAttachment[]
  ) => Promise<boolean>
  onSteer: (prompt: QueuedPrompt) => Promise<boolean>
  placeholder?: string
  onOpenSettings?: () => void
  workspace?: WorkspaceInfo | null
}
