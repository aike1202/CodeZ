import { createHash, randomUUID } from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import type {
  PermissionAction,
  PermissionAnalysisStatus,
  PermissionApprovalResponse,
  PermissionCapability,
  PermissionCheck,
  PermissionDecision,
  PermissionImpact,
  PermissionMode,
  PermissionRequest,
  PermissionRiskLevel
} from '../../shared/types/permission'
import { allowedScopesForDecision } from '../../shared/types/permission'
import { CriticalOperationGuard } from './permission/CriticalOperationGuard'
import { NestedCommandExpander } from './permission/NestedCommandExpander'
import { PathImpactAnalyzer } from './permission/PathImpactAnalyzer'
import { PermissionDecisionEngine } from './permission/PermissionDecisionEngine'
import { getPermissionAuditLog } from './permission/PermissionAuditLog'
import { getPermissionRuleStore } from './permission/PermissionRuleStore'
import { ShellAnalysisService } from './permission/ShellAnalysisService'
import type { SmartApprovalClient } from './permission/SmartApprovalService'
import { getWorkspacePermissionStore } from './permission/workspacePermissionStore'
import { classifyKnownCommand, type CommandAssessment } from './permission/commandPolicies'
import type { PermissionShellKind } from './permission/operationTypes'

export type PermissionResult = 'allow' | 'ask' | 'deny'
export type { PermissionRequest } from '../../shared/types/permission'

export interface PermissionEvaluationContext {
  workspaceRoot: string
  cwd: string
  platform: NodeJS.Platform
  shellKind?: PermissionShellKind
  sessionId?: string
  agentId?: string
  mode: PermissionMode
  smartApprovalClient?: SmartApprovalClient | null
}

export type PermissionRequestHandler = (request: PermissionRequest) => Promise<boolean | PermissionApprovalResponse>

export interface PermissionToolAuthorization {
  allowed: boolean
  requestId: string
  error?: string
}

const READ_ONLY_TOOLS = new Set(['Read', 'list_files', 'Glob', 'Grep', 'Skill', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'update_resume_state', 'AskUserQuestion'])
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch'])
const EXTERNAL_EFFECT_TOOLS = new Map<string, { reason: string; ruleId: string; riskLevel: PermissionRiskLevel }>([
  ['DelegateTasks', { reason: '并行执行计划步骤', ruleId: 'tool.delegation.execute', riskLevel: 2 }],
  ['PushNotification', { reason: '发送系统通知', ruleId: 'tool.notification.send', riskLevel: 1 }]
])

function commandFromArgs(args: any): string {
  return args?.command ?? args?.commandLine ?? args?.CommandLine ?? ''
}

function targetPathFromArgs(args: any): string | null {
  return args?.file_path ?? args?.filePath ?? args?.TargetFile ?? args?.path ?? null
}

function decisionFromChecks(input: {
  checks: PermissionCheck[]
  action: PermissionAction
  riskLevel: PermissionRiskLevel
  reason: string
  ruleId: string
  pattern: string
  analysisStatus?: PermissionAnalysisStatus
  hardline?: boolean
  impacts?: PermissionImpact[]
  snapshots?: PermissionDecision['snapshots']
}): PermissionDecision {
  const hardline = input.hardline ?? false
  const primary = input.checks.find((check) => check.action !== 'allow') ?? input.checks[0]
  return {
    action: input.action,
    permission: primary?.permission ?? 'unknown',
    checks: input.checks,
    analysisStatus: input.analysisStatus ?? 'parsed',
    hardline,
    riskLevel: input.riskLevel,
    reason: input.reason,
    ruleId: input.ruleId,
    normalizedPattern: input.pattern,
    impacts: input.impacts ?? [],
    snapshots: input.snapshots ?? [],
    critical: hardline
  }
}

interface ShellScanResult {
  checks: PermissionCheck[]
  analysisStatus: PermissionAnalysisStatus
  highest: CommandAssessment | null
  snapshots: PermissionDecision['snapshots']
  critical: PermissionDecision | null
}

export class PermissionManager {
  private static instance: PermissionManager
  constructor(
    private readonly shellAnalysis = new ShellAnalysisService(),
    private readonly criticalGuard = new CriticalOperationGuard(),
    private readonly pathAnalyzer = new PathImpactAnalyzer(),
    private readonly nestedExpander = new NestedCommandExpander(),
    private readonly decisionEngine = new PermissionDecisionEngine()
  ) {}

  static getInstance(): PermissionManager {
    if (!PermissionManager.instance) PermissionManager.instance = new PermissionManager()
    return PermissionManager.instance
  }

  async evaluateToolCall(toolName: string, args: unknown, context: PermissionEvaluationContext): Promise<PermissionDecision> {
    if (READ_ONLY_TOOLS.has(toolName)) {
      return this.evaluateCapability('read', toolName, '工作区只读工具', `tool.read.${toolName}`, 0, context)
    }
    if (toolName === 'SubAgentRunner') {
      const subagentType = typeof (args as any)?.subagent_type === 'string'
        ? (args as any).subagent_type.trim() || 'unknown'
        : 'unknown'
      return this.evaluateCapability(
        'read',
        `SubAgentRunner:${subagentType}`,
        '启动受限子代理',
        'tool.subagent.restricted',
        1,
        context
      )
    }
    if (WRITE_TOOLS.has(toolName)) return this.evaluateWrite(toolName, args, context)
    if (WEB_TOOLS.has(toolName)) {
      return this.evaluateCapability('network', toolName, '访问外部网络', `tool.network.${toolName}`, 2, context)
    }
    const externalEffect = EXTERNAL_EFFECT_TOOLS.get(toolName)
    if (externalEffect) {
      return this.evaluateCapability(
        'external_effect',
        toolName,
        externalEffect.reason,
        externalEffect.ruleId,
        externalEffect.riskLevel,
        context
      )
    }
    if (toolName === 'rollback_last_edit') {
      return this.evaluateCapability('rollback', toolName, '回滚工作区修改', 'tool.rollback', 3, context)
    }
    if (toolName === 'Bash' || toolName === 'PowerShell' || toolName === 'run_command') return this.evaluateShell(toolName, args, context)
    return this.evaluateCapability('unknown', toolName, '未知工具调用', 'unknown.tool', 2, context)
  }

  private async evaluateWrite(toolName: string, args: unknown, context: PermissionEvaluationContext): Promise<PermissionDecision> {
    const target = targetPathFromArgs(args)
    if (!target) {
      return this.evaluateCapability('external_directory', toolName, '写入目标路径未知', 'tool.write.unknown-path', 2, context, 'unparsed')
    }
    const impact = await this.pathAnalyzer.analyze(target, context.workspaceRoot, context.cwd)
    if (impact.sensitive) {
      return this.hardlineDecision('critical.credential.access', '修改敏感配置或凭据文件', impact.resolvedPath, [
        { kind: 'credential', target: impact.resolvedPath }
      ])
    }
    const permission: PermissionCapability = impact.insideWorkspace ? 'edit' : 'external_directory'
    const reason = impact.insideWorkspace ? '修改工作区文件' : '修改工作区外文件'
    const ruleId = impact.insideWorkspace ? 'tool.write.workspace' : 'tool.write.external'
    return this.evaluateCapability(permission, impact.resolvedPath, reason, ruleId, impact.insideWorkspace ? 1 : 2, context, 'parsed', [
      { kind: impact.insideWorkspace ? 'workspace' : 'external-path', target: impact.resolvedPath }
    ])
  }

  private async evaluateShell(toolName: string, args: unknown, context: PermissionEvaluationContext): Promise<PermissionDecision> {
    const command = commandFromArgs(args).trim()
    if (!command) {
      const check: PermissionCheck = {
        permission: 'shell_unparsed',
        pattern: toolName,
        action: 'deny',
        reason: 'Shell 命令为空或无法读取'
      }
      return decisionFromChecks({
        checks: [check],
        action: 'deny',
        riskLevel: 2,
        reason: check.reason,
        ruleId: 'shell.empty-command',
        pattern: toolName,
        analysisStatus: 'unparsed'
      })
    }
    const shell: PermissionShellKind = context.shellKind ?? (toolName === 'PowerShell' ? 'powershell' : 'bash')
    const scan = await this.scanShellCommand(shell, command, context, context.cwd, true, 0, new Set<string>())
    if (scan.critical) return scan.critical
    const { checks, highest, snapshots } = scan
    let { analysisStatus } = scan
    const uniqueChecks = Array.from(
      new Map(checks.map((check) => [`${check.permission}\u0000${check.pattern}`, check])).values()
    )
    if (uniqueChecks.length === 0) {
      uniqueChecks.push(await this.createCheck('shell_unparsed', command, 'Shell 命令无法识别', context))
      analysisStatus = 'unparsed'
    }
    const action = this.decisionEngine.aggregate(uniqueChecks)
    const decisive = uniqueChecks.find((check) => check.action === 'deny') ?? uniqueChecks.find((check) => check.action === 'ask')
    const unparsed = uniqueChecks.some((check) => check.permission === 'shell_unparsed')
    return decisionFromChecks({
      checks: uniqueChecks,
      action,
      riskLevel: unparsed ? Math.max(highest?.riskLevel ?? 1, 2) as PermissionRiskLevel : highest?.riskLevel ?? 1,
      reason: decisive?.reason ?? highest?.reason ?? '执行 Shell 命令',
      ruleId: unparsed ? 'shell.unparsed' : highest?.ruleId ?? 'shell.command',
      pattern: command,
      analysisStatus,
      snapshots
    })
  }

  private async scanShellCommand(
    shell: PermissionShellKind,
    command: string,
    context: PermissionEvaluationContext,
    cwd: string,
    includeNormalChecks: boolean,
    depth: number,
    seen: Set<string>
  ): Promise<ShellScanResult> {
    const critical = await this.criticalGuard.analyzeRaw(shell, command, context.workspaceRoot)
    if (critical) return { checks: [], analysisStatus: 'parsed', highest: null, snapshots: [], critical }
    const graph = await this.shellAnalysis.parse(shell, command)
    const checks: PermissionCheck[] = []
    const snapshots: PermissionDecision['snapshots'] = []
    let analysisStatus: PermissionAnalysisStatus = graph.diagnostics.length > 0 ? 'unparsed' : 'parsed'
    let highest: CommandAssessment | null = null
    const addUnparsed = async (pattern: string, reason: string): Promise<void> => {
      analysisStatus = 'unparsed'
      checks.push(await this.createCheck('shell_unparsed', pattern, reason, context))
    }

    for (const operation of graph.operations) {
      const pattern = operation.source || command
      const assessment = classifyKnownCommand(operation.argv)
      if (includeNormalChecks) {
        const permission = assessment?.permission === 'hardline' ? 'shell' : assessment?.permission ?? 'shell'
        checks.push(await this.createCheck(permission, pattern, assessment?.reason ?? '执行 Shell 命令', context))
        if (assessment && (!highest || assessment.riskLevel > highest.riskLevel)) highest = assessment
      }
      const expanded = await this.nestedExpander.expandCommand(shell, operation.argv, context.workspaceRoot, cwd, depth, seen)
      snapshots.push(...expanded.snapshots)
      if (expanded.opaqueReason) {
        await addUnparsed(pattern, `无法完整分析命令：${expanded.opaqueReason}`)
        continue
      }
      if (!expanded.command || !expanded.shell) continue
      const expansionKey = `${expanded.shell}\u0000${expanded.cwd ?? cwd}\u0000${expanded.command}\u0000${expanded.snapshots.map((item) => item.path).join('\u0000')}`
      if (depth >= 4 || seen.has(expansionKey)) {
        await addUnparsed(pattern, `无法完整分析命令：${depth >= 4 ? 'nested-depth' : 'nested-cycle'}`)
        continue
      }
      const nextSeen = new Set(seen)
      nextSeen.add(expansionKey)
      const nested = await this.scanShellCommand(
        expanded.shell,
        expanded.command,
        context,
        expanded.cwd ?? cwd,
        expanded.kind === 'wrapper',
        depth + 1,
        nextSeen
      )
      snapshots.push(...nested.snapshots)
      if (nested.critical) {
        return {
          checks,
          analysisStatus,
          highest,
          snapshots,
          critical: { ...nested.critical, snapshots }
        }
      }
      checks.push(...nested.checks)
      if (nested.analysisStatus === 'unparsed') analysisStatus = 'unparsed'
      if (nested.highest && (!highest || nested.highest.riskLevel > highest.riskLevel)) highest = nested.highest
    }
    if (graph.diagnostics.length > 0) await addUnparsed(command, 'Shell 语法无法完整分析')
    return { checks, analysisStatus, highest, snapshots, critical: null }
  }

  private async createCheck(
    permission: PermissionCapability,
    pattern: string,
    reason: string,
    context: PermissionEvaluationContext
  ): Promise<PermissionCheck> {
    const explicitRule = await getPermissionRuleStore().resolve(context.workspaceRoot, context.sessionId, permission, pattern)
    const { action } = this.decisionEngine.decide({ mode: context.mode, permission, explicitRule })
    return { permission, pattern, action, reason }
  }

  private async evaluateCapability(
    permission: PermissionCapability,
    pattern: string,
    reason: string,
    ruleId: string,
    riskLevel: PermissionRiskLevel,
    context: PermissionEvaluationContext,
    analysisStatus: PermissionAnalysisStatus = 'parsed',
    impacts: PermissionImpact[] = []
  ): Promise<PermissionDecision> {
    const check = await this.createCheck(permission, pattern, reason, context)
    return decisionFromChecks({ checks: [check], action: check.action, riskLevel, reason, ruleId, pattern, analysisStatus, impacts })
  }

  private hardlineDecision(ruleId: string, reason: string, pattern: string, impacts: PermissionImpact[] = []): PermissionDecision {
    const check: PermissionCheck = { permission: 'hardline', pattern, action: 'ask', reason }
    return decisionFromChecks({
      checks: [check],
      action: 'ask',
      riskLevel: 4,
      reason,
      ruleId,
      pattern,
      hardline: true,
      impacts
    })
  }

  createPermissionRequest(toolName: string, args: unknown, context: PermissionEvaluationContext, decision: PermissionDecision): PermissionRequest {
    return {
      ...decision,
      id: randomUUID(),
      sessionId: context.sessionId,
      agentId: context.agentId,
      toolName,
      description: decision.reason,
      args,
      allowedScopes: allowedScopesForDecision(decision.hardline)
    }
  }

  async rememberApproval(request: PermissionRequest, response: PermissionApprovalResponse, context: PermissionEvaluationContext): Promise<void> {
    if (!response.approved || response.scope === 'once' || request.hardline) return
    for (const check of request.checks.filter((item) => item.action === 'ask')) {
      await getPermissionRuleStore().remember({
        workspaceRoot: context.workspaceRoot,
        sessionId: context.sessionId,
        permission: check.permission,
        pattern: check.pattern,
        action: 'allow',
        scope: response.scope,
        hardline: false
      })
    }
  }

  async revalidate(decision: PermissionDecision): Promise<boolean> {
    for (const snapshot of decision.snapshots) {
      try {
        const content = await fs.readFile(snapshot.path)
        if (createHash('sha256').update(content).digest('hex') !== snapshot.sha256) return false
      } catch {
        return false
      }
    }
    return true
  }

  async audit(
    toolName: string,
    decision: PermissionDecision,
    context: PermissionEvaluationContext,
    approvalResponse?: PermissionApprovalResponse
  ): Promise<void> {
    await getPermissionAuditLog().append({
      toolName,
      sessionId: context.sessionId,
      agentId: context.agentId,
      mode: context.mode,
      decision,
      approvalResponse
    })
  }
}

export async function authorizePermissionToolCall(
  toolName: string,
  parsedArgs: unknown,
  workspaceRoot: string,
  onPermissionRequest?: PermissionRequestHandler,
  smartApprovalClient?: SmartApprovalClient | null,
  sessionId?: string,
  agentId?: string
): Promise<PermissionToolAuthorization> {
  const permissionManager = PermissionManager.getInstance()
  const context: PermissionEvaluationContext = {
    workspaceRoot,
    cwd: workspaceRoot,
    platform: process.platform,
    shellKind: toolName === 'PowerShell' ? 'powershell' : toolName === 'Bash' ? 'bash' : undefined,
    mode: await getWorkspacePermissionStore().getMode(workspaceRoot),
    smartApprovalClient,
    sessionId,
    agentId
  }
  const decision = await permissionManager.evaluateToolCall(toolName, parsedArgs, context)
  await permissionManager.audit(toolName, decision, context)
  const request = permissionManager.createPermissionRequest(toolName, parsedArgs, context, decision)

  if (decision.action === 'allow') {
    return await permissionManager.revalidate(decision)
      ? { allowed: true, requestId: request.id }
      : { allowed: false, requestId: request.id, error: 'Error: Permission inputs changed before execution.' }
  }
  if (decision.action === 'deny') {
    return {
      allowed: false,
      requestId: request.id,
      error: 'Error: Tool execution denied by security policy.'
    }
  }
  if (!onPermissionRequest) {
    return {
      allowed: false,
      requestId: request.id,
      error: 'Error: Tool execution denied. No approval handler registered.'
    }
  }

  try {
    const rawResponse = await onPermissionRequest(request)
    const response: PermissionApprovalResponse = typeof rawResponse === 'boolean'
      ? { approved: rawResponse, scope: 'once' }
      : rawResponse
    const valid = response.approved && await permissionManager.revalidate(decision)
    if (valid) await permissionManager.rememberApproval(request, response, context)
    await permissionManager.audit(toolName, decision, context, response)
    return valid
      ? { allowed: true, requestId: request.id }
      : {
          allowed: false,
          requestId: request.id,
          error: response.approved
            ? 'Error: Permission inputs changed before execution.'
            : 'Error: User denied permission for this operation.'
        }
  } catch (error: any) {
    return {
      allowed: false,
      requestId: request.id,
      error: `Error: Permission approval failed: ${error?.message || String(error)}`
    }
  }
}
