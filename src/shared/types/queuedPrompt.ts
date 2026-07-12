import type { ComposerImageAttachment, ImageAttachment } from './attachment'

export type QueuedPromptStatus = 'queued' | 'steering' | 'failed'

export interface QueuedPrompt {
  id: string
  text: string
  modelName: string
  attachments: ComposerImageAttachment[]
  createdAt: number
  status: QueuedPromptStatus
}

export interface ChatSteerInput {
  queueId: string
  text: string
  attachments?: ImageAttachment[]
}

export interface ChatSteerResult {
  accepted: boolean
  reason?: 'NO_ACTIVE_RUNNER' | 'RUNNER_FINISHING' | 'INVALID_INPUT'
}
