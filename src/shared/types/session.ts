import type { TaskItem } from './task'
import type { SessionRuntimeRef } from './context'
import type { ImageAttachment } from './attachment'

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
  /** 轻量任务清单——落盘持久化，会话恢复时加载 */
  tasks?: TaskItem[]
  runtime?: SessionRuntimeRef
}
