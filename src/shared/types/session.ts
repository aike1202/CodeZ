export interface SessionData {
  id: string
  projectId: string
  summary: string
  relativeTime: string
  messages: Array<{ id: string; role: string; content: string }>
  isArchived?: boolean
  isDeleted?: boolean
  deletedAt?: number
  linkedPlanSlug?: string
}
