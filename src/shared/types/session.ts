import type { TodoItem } from './todo'
import type { SessionRuntimeRef } from './context'
import type { ImageAttachment } from './attachment'
import type { QueuedPrompt } from './queuedPrompt'

export interface SessionData {
  id: string
  projectId: string
  summary: string
  relativeTime: string
  messages: Array<{ id: string; role: string; content: string; attachments?: ImageAttachment[] }>
  isArchived?: boolean
  isDeleted?: boolean
  deletedAt?: number
  linkedPlanSlug?: string
  queuedPrompts?: QueuedPrompt[]
  runtime?: SessionRuntimeRef
  toolRuntime?: {
    activatedDeferredTools?: Record<string, string[]>
  }
}
