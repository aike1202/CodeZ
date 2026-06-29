export type RuleScope = 'global' | 'workspace'

export interface RuleFile {
  filename: string
  scope: RuleScope
  path: string // absolute path for reference
  
  // Parsed YAML frontmatter
  description?: string
  globs?: string
  alwaysApply?: boolean
  
  // Raw content minus the frontmatter
  content: string
}
