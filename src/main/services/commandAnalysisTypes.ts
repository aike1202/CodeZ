export type CommandRisk = 'safe' | 'write' | 'network' | 'destructive' | 'unknown'
export type CommandAction = 'read' | 'modify' | 'delete' | 'network' | 'git' | 'service' | 'unknown'

export interface CommandRuleOption {
  id: 'exact' | 'safe-read' | 'package-manager' | 'git-read' | 'git-write' | 'network-command' | 'runner'
  label: string
  rule: string
  description: string
}

export interface CommandAnalysis {
  risk: CommandRisk
  action: CommandAction
  reason: string
  impacts: string[]
  ruleOptions: CommandRuleOption[]
}
