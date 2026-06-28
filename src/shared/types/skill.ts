export interface SkillDefinition {
  id: string
  name: string
  description: string
  triggers?: string[]
  content: string
  path?: string
  enabled?: boolean
  isGlobal?: boolean
}

export interface ExternalSourceCheck {
  sourceName: string
  count: number
}

export interface ExternalSkillCheckResult {
  hasUpdates: boolean
  totalCount: number
  sources: ExternalSourceCheck[]
}
