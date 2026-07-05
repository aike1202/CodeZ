export interface SkillDefinition {
  id: string
  name: string
  description: string
  triggers?: string[]
  content: string
  path?: string
  enabled?: boolean
  isGlobal?: boolean
  /** 系统内置技能：不可删除，但可启用/停用 */
  builtin?: boolean
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

/** 外部工具（Codex / Claude）中的单个可导入技能。 */
export interface ExternalSkillItem {
  /** 技能目录名，作为导入的唯一标识 */
  dirName: string
  /** 来源工具名称，如 Codex / Claude */
  sourceName: string
  name: string
  description: string
  /** 是否已导入到 CodeZ 全局技能目录 */
  imported: boolean
  /** 源文件较已导入版本更新，可覆盖导入 */
  hasUpdate: boolean
}

/** 按来源分组的外部技能列表。 */
export interface ExternalSkillGroup {
  sourceName: string
  skills: ExternalSkillItem[]
}
