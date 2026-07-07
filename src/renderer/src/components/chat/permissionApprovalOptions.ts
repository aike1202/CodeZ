export type PermissionRuleScope = 'once' | 'session' | 'workspace'

export interface CommandRuleOption {
  id: string
  label: string
  rule: string
  description?: string
}

export interface PermissionScopeOption {
  id: PermissionRuleScope
  label: string
}

export const PERMISSION_SCOPE_OPTIONS: PermissionScopeOption[] = [
  { id: 'once', label: '仅此次允许执行' },
  { id: 'session', label: '允许本会话使用' },
  { id: 'workspace', label: '始终允许本项目使用' }
]

export function generateCommandRuleOptions(command: string = ''): CommandRuleOption[] {
  const trimmed = command.trim()
  return [{ id: 'exact', label: '仅此完整命令', rule: trimmed, description: '只允许当前这条完整命令。' }]
}
