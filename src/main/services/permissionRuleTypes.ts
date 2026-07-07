import type { CommandRisk } from './CommandAnalyzer'

export type PermissionRuleScope = 'session' | 'workspace' | 'global'
export type PermissionRuleEffect = 'allow' | 'ask' | 'deny'
export type StoredCommandRule = string | {
  rule: string
  maxRisk: CommandRisk
  effect?: PermissionRuleEffect
}
export interface NormalizedCommandRule {
  rule: string
  maxRisk: CommandRisk
  effect: PermissionRuleEffect
}

export function isRiskAllowedByRule(commandRisk: CommandRisk, maxRisk: CommandRisk): boolean {
  const rank: Record<CommandRisk, number> = {
    safe: 0,
    write: 1,
    network: 2,
    unknown: 3,
    destructive: 4
  }
  return rank[commandRisk] <= rank[maxRisk]
}
