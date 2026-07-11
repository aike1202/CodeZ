import type { PermissionImpact, PermissionRiskLevel } from '../../../shared/types/permission'
import type { CommandAssessment } from './commandPolicies'

export interface SmartApprovalClient {
  assess(input: { command: string; operations: unknown[]; impacts: PermissionImpact[] }): Promise<{
    riskLevel: PermissionRiskLevel
    confidence: number
    reason: string
  }>
}

export class SmartApprovalService {
  constructor(private readonly client: SmartApprovalClient | null) {}

  async assess(input: Parameters<SmartApprovalClient['assess']>[0]): Promise<CommandAssessment | null> {
    if (!this.client) return null
    try {
      const result = await Promise.race([
        this.client.assess(input),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
      ])
      if (!Number.isInteger(result.riskLevel) || result.riskLevel < 0 || result.riskLevel > 4 || result.confidence < 0.9) return null
      return { permission: 'unknown', riskLevel: result.riskLevel, ruleId: 'smart.unknown-command', reason: result.reason }
    } catch {
      return null
    }
  }
}
