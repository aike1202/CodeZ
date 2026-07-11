import { app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import type { PermissionAction, PermissionApprovalScope, PermissionCapability } from '../../../shared/types/permission'
import { matchPermissionPattern } from './PermissionPattern'
import { normalizeWorkspaceKey } from './workspacePermissionStore'

interface StoredRule {
  workspace: string
  sessionId?: string
  permission?: PermissionCapability
  pattern: string
  action: Extract<PermissionAction, 'allow' | 'deny'>
}

const PERMISSION_CAPABILITIES = new Set<PermissionCapability>([
  'read', 'edit', 'shell', 'shell_unparsed', 'network', 'external_effect',
  'external_directory', 'delete', 'rollback', 'unknown', 'hardline'
])

function isStoredRule(value: unknown): value is StoredRule {
  if (!value || typeof value !== 'object') return false
  const rule = value as Partial<StoredRule>
  return typeof rule.workspace === 'string' &&
    (rule.sessionId === undefined || typeof rule.sessionId === 'string') &&
    (rule.permission === undefined || PERMISSION_CAPABILITIES.has(rule.permission)) &&
    typeof rule.pattern === 'string' &&
    (rule.action === 'allow' || rule.action === 'deny')
}

export interface RememberPermissionRuleInput {
  workspaceRoot: string
  sessionId?: string
  permission: PermissionCapability
  pattern: string
  action: 'allow' | 'deny'
  scope: Exclude<PermissionApprovalScope, 'once'>
  hardline: boolean
}

export class PermissionRuleStore {
  private sessionRules: StoredRule[] = []
  constructor(private readonly filePath = app?.getPath ? path.join(app.getPath('userData'), 'permission-rules.json') : ':memory:') {}

  private async workspaceRules(): Promise<StoredRule[]> {
    if (this.filePath === ':memory:') return []
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      return Array.isArray(parsed?.rules) ? parsed.rules.filter(isStoredRule) : []
    } catch {
      return []
    }
  }

  async remember(input: RememberPermissionRuleInput): Promise<void> {
    if (input.action === 'allow' && (input.hardline || input.permission === 'hardline')) {
      throw new Error('Hardline approvals cannot be persisted')
    }
    const rule: StoredRule = {
      workspace: normalizeWorkspaceKey(input.workspaceRoot),
      sessionId: input.scope === 'session' ? input.sessionId : undefined,
      permission: input.permission,
      pattern: input.pattern,
      action: input.action
    }
    const sameRule = (item: StoredRule) =>
      item.workspace === rule.workspace &&
      item.sessionId === rule.sessionId &&
      (item.permission ?? 'shell') === rule.permission &&
      item.pattern === rule.pattern
    if (input.scope === 'session') {
      this.sessionRules = [...this.sessionRules.filter((item) => !sameRule(item)), rule]
      return
    }
    if (this.filePath === ':memory:') {
      this.sessionRules = [...this.sessionRules.filter((item) => !sameRule(item)), rule]
      return
    }
    const rules = await this.workspaceRules()
    const next = [...rules.filter((item) => !sameRule(item)), rule]
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify({ rules: next }, null, 2), 'utf8')
  }

  async resolve(
    workspaceRoot: string,
    sessionId: string | undefined,
    permission: PermissionCapability,
    pattern: string
  ): Promise<'allow' | 'deny' | null> {
    const workspace = normalizeWorkspaceKey(workspaceRoot)
    const workspaceRules = (await this.workspaceRules()).filter((rule) => !rule.sessionId)
    const memoryWorkspaceRules = this.sessionRules.filter((rule) => !rule.sessionId)
    const sessionRules = this.sessionRules.filter((rule) => rule.sessionId === sessionId)
    const candidates = [...workspaceRules, ...memoryWorkspaceRules, ...sessionRules].filter(
      (rule) =>
        rule.workspace === workspace &&
        (rule.permission ?? 'shell') === permission &&
        matchPermissionPattern(pattern, rule.pattern)
    )
    return candidates.at(-1)?.action ?? null
  }
}

let instance: PermissionRuleStore | null = null
export function getPermissionRuleStore(): PermissionRuleStore {
  if (!instance) instance = new PermissionRuleStore()
  return instance
}
