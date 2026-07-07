import { CommandAnalyzer, type CommandRisk } from './CommandAnalyzer'
import {
  isRiskAllowedByRule,
  type NormalizedCommandRule,
  type PermissionRuleEffect,
  type StoredCommandRule
} from './permissionRuleTypes'

export interface MatchedCommandRule {
  effect: PermissionRuleEffect
  specificity: number
}

export function createStoredCommandRule(
  rule: string,
  effect: PermissionRuleEffect = 'allow'
): NormalizedCommandRule {
  return { rule, maxRisk: CommandAnalyzer.analyzeRule(rule), effect }
}

export function normalizeStoredCommandRule(rule: StoredCommandRule): NormalizedCommandRule {
  if (typeof rule === 'string') return createStoredCommandRule(rule)
  return { ...rule, effect: rule.effect || 'allow' }
}

export function matchStoredCommandRule(
  storedRule: StoredCommandRule,
  command: string,
  commandRisk: CommandRisk
): MatchedCommandRule | null {
  const { rule, maxRisk, effect } = normalizeStoredCommandRule(storedRule)
  if (!isRiskAllowedByRule(commandRisk, maxRisk)) return null
  if (rule.endsWith('*')) {
    const prefix = rule.slice(0, -1).trim()
    return command.startsWith(prefix) || command === prefix
      ? { effect, specificity: prefix.length }
      : null
  }
  return command === rule ? { effect, specificity: rule.length + 1000 } : null
}
