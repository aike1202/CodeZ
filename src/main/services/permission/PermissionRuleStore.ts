import { app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import type { PermissionAction, PermissionApprovalScope, PermissionRiskLevel } from '../../../shared/types/permission'
import { normalizeWorkspaceKey } from './workspacePermissionStore'

interface StoredRule {
  workspace: string
  sessionId?: string
  pattern: string
  action: Extract<PermissionAction, 'allow' | 'deny'>
}

export interface RememberPermissionRuleInput {
  workspaceRoot: string
  sessionId?: string
  pattern: string
  action: 'allow' | 'deny'
  scope: Exclude<PermissionApprovalScope, 'once'>
  riskLevel: PermissionRiskLevel
}

export class PermissionRuleStore {
  private sessionRules: StoredRule[] = []
  constructor(private readonly filePath = app?.getPath ? path.join(app.getPath('userData'), 'permission-rules.json') : ':memory:') {}

  private async workspaceRules(): Promise<StoredRule[]> {
    if (this.filePath === ':memory:') return []
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      return Array.isArray(parsed?.rules) ? parsed.rules : []
    } catch {
      return []
    }
  }

  async remember(input: RememberPermissionRuleInput): Promise<void> {
    if (input.action === 'allow' && input.riskLevel === 4) throw new Error('L4 approvals cannot be persisted')
    const rule: StoredRule = { workspace: normalizeWorkspaceKey(input.workspaceRoot), sessionId: input.sessionId, pattern: input.pattern, action: input.action }
    if (input.scope === 'session') {
      this.sessionRules = [...this.sessionRules.filter((item) => !(item.workspace === rule.workspace && item.sessionId === rule.sessionId && item.pattern === rule.pattern)), rule]
      return
    }
    if (this.filePath === ':memory:') {
      this.sessionRules = [...this.sessionRules.filter((item) => !(item.workspace === rule.workspace && item.pattern === rule.pattern)), { ...rule, sessionId: undefined }]
      return
    }
    const rules = await this.workspaceRules()
    const next = [...rules.filter((item) => !(item.workspace === rule.workspace && item.pattern === rule.pattern)), { ...rule, sessionId: undefined }]
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify({ rules: next }, null, 2), 'utf8')
  }

  async resolve(workspaceRoot: string, sessionId: string | undefined, pattern: string): Promise<'allow' | 'deny' | null> {
    const workspace = normalizeWorkspaceKey(workspaceRoot)
    const candidates = [...this.sessionRules, ...(await this.workspaceRules())]
      .filter((rule) => rule.workspace === workspace && rule.pattern === pattern && (!rule.sessionId || rule.sessionId === sessionId))
    return candidates.find((rule) => rule.action === 'deny')?.action || candidates.at(-1)?.action || null
  }
}

let instance: PermissionRuleStore | null = null
export function getPermissionRuleStore(): PermissionRuleStore {
  if (!instance) instance = new PermissionRuleStore()
  return instance
}
