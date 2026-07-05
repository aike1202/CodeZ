export type RuleScope = 'global' | 'workspace'

export interface RuleFile {
  filename: string
  scope: RuleScope
  path: string // absolute path for reference
  projectId?: string // ID of the project if scope is workspace
  
  // Parsed YAML frontmatter
  description?: string
  globs?: string
  alwaysApply?: boolean
  enabled?: boolean
  
  // Raw content minus the frontmatter
  content: string
}
