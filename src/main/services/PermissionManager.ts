import { createHash, randomUUID } from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import type {
  PermissionApprovalResponse,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionRiskLevel
} from '../../shared/types/permission'
import { allowedScopesForRisk } from '../../shared/types/permission'
import { CriticalOperationGuard } from './permission/CriticalOperationGuard'
import { NestedCommandExpander } from './permission/NestedCommandExpander'
import { PathImpactAnalyzer } from './permission/PathImpactAnalyzer'
import { PermissionDecisionEngine } from './permission/PermissionDecisionEngine'
import { getPermissionAuditLog } from './permission/PermissionAuditLog'
import { getPermissionRuleStore } from './permission/PermissionRuleStore'
import { ShellAnalysisService } from './permission/ShellAnalysisService'
import { SmartApprovalService, type SmartApprovalClient } from './permission/SmartApprovalService'
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

const READ_ONLY_TOOLS = new Set(['Read', 'list_files', 'Glob', 'Grep', 'Skill', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'update_resume_state', 'AskUserQuestion'])
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch'])

function commandFromArgs(args: any): string {
  return args?.command ?? args?.commandLine ?? args?.CommandLine ?? ''
}

function targetPathFromArgs(args: any): string | null {
  return args?.file_path ?? args?.filePath ?? args?.TargetFile ?? args?.path ?? null
}

function assessmentDecision(assessment: CommandAssessment, pattern: string, action: PermissionResult, snapshots: PermissionDecision['snapshots'] = []): PermissionDecision {
  return {
    action,
    riskLevel: assessment.riskLevel,
    reason: assessment.reason,
    ruleId: assessment.ruleId,
    normalizedPattern: pattern,
    impacts: [],
    snapshots,
    critical: assessment.riskLevel === 4
  }
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
    if (READ_ONLY_TOOLS.has(toolName)) return assessmentDecision({ riskLevel: 0, ruleId: `tool.read.${toolName}`, reason: '工作区只读工具' }, toolName, 'allow')
    if (WRITE_TOOLS.has(toolName)) return this.evaluateWrite(toolName, args, context)
    if (WEB_TOOLS.has(toolName)) return this.applyDecision({ riskLevel: 2, ruleId: `tool.network.${toolName}`, reason: '访问外部网络' }, toolName, context)
    if (toolName === 'rollback_last_edit') return this.applyDecision({ riskLevel: 3, ruleId: 'tool.rollback', reason: '回滚工作区修改' }, toolName, context)
    if (toolName === 'Bash' || toolName === 'PowerShell' || toolName === 'run_command') return this.evaluateShell(toolName, args, context)
    return this.applyDecision(null, toolName, context)
  }

  private async evaluateWrite(toolName: string, args: unknown, context: PermissionEvaluationContext): Promise<PermissionDecision> {
    const target = targetPathFromArgs(args)
    if (!target) return assessmentDecision({ riskLevel: 2, ruleId: 'tool.write.unknown-path', reason: '写入目标路径未知' }, toolName, 'ask')
    const impact = await this.pathAnalyzer.analyze(target, context.workspaceRoot, context.cwd)
    if (impact.sensitive) return assessmentDecision({ riskLevel: 4, ruleId: 'critical.credential.access', reason: '修改敏感配置或凭据文件' }, target, 'ask')
    const assessment: CommandAssessment = impact.insideWorkspace
      ? { riskLevel: 1, ruleId: 'tool.write.workspace', reason: '修改工作区文件' }
      : { riskLevel: 2, ruleId: 'tool.write.external', reason: '修改工作区外文件' }
    const decision = this.applyDecision(assessment, impact.resolvedPath, context)
    decision.impacts = [{ kind: impact.insideWorkspace ? 'workspace' : 'external-path', target: impact.resolvedPath }]
    return decision
  }

  private async evaluateShell(toolName: string, args: unknown, context: PermissionEvaluationContext): Promise<PermissionDecision> {
    const command = commandFromArgs(args).trim()
    if (!command) return assessmentDecision({ riskLevel: 4, ruleId: 'critical.hidden.dynamic-command', reason: 'Shell 命令为空或无法读取' }, toolName, 'deny')
    const shell: PermissionShellKind = context.shellKind ?? (toolName === 'PowerShell' ? 'powershell' : 'bash')
    const critical = await this.criticalGuard.analyzeRaw(shell, command, context.workspaceRoot)
    if (critical) return critical
    const explicitRule = await getPermissionRuleStore().resolve(context.workspaceRoot, context.sessionId, command)
    if (explicitRule === 'deny') return assessmentDecision({ riskLevel: 0, ruleId: 'user.rule.deny', reason: '用户拒绝规则' }, command, 'deny')
    const graph = await this.shellAnalysis.parse(shell, command)
    let highest: CommandAssessment | null = null
    const snapshots: PermissionDecision['snapshots'] = []
    for (const operation of graph.operations) {
      let assessment = classifyKnownCommand(operation.argv)
      const expanded = await this.nestedExpander.expandCommand(shell, operation.argv, context.workspaceRoot, context.cwd)
      snapshots.push(...expanded.snapshots)
      if (expanded.opaqueReason) assessment = { riskLevel: 4, ruleId: 'critical.hidden.dynamic-command', reason: '嵌套命令无法可靠展开' }
      if (expanded.command && expanded.shell) {
        const nestedCritical = await this.criticalGuard.analyzeRaw(expanded.shell, expanded.command, context.workspaceRoot)
        if (nestedCritical) return { ...nestedCritical, snapshots: [...nestedCritical.snapshots, ...snapshots] }
        const nestedGraph = await this.shellAnalysis.parse(expanded.shell, expanded.command)
        for (const child of nestedGraph.operations) {
          const childAssessment = classifyKnownCommand(child.argv)
          if (childAssessment && (!assessment || childAssessment.riskLevel > assessment.riskLevel)) assessment = childAssessment
        }
      }
      if (assessment && (!highest || assessment.riskLevel > highest.riskLevel)) highest = assessment
    }
    if (!highest && context.mode === 'auto') {
      highest = await new SmartApprovalService(context.smartApprovalClient ?? null).assess({ command, operations: graph.operations, impacts: [] })
    }
    const result = this.applyDecision(highest, command, context, explicitRule)
    result.snapshots = snapshots
    return result
  }

  private applyDecision(assessment: CommandAssessment | null, pattern: string, context: PermissionEvaluationContext, explicitRule: 'allow' | null = null): PermissionDecision {
    const riskLevel: PermissionRiskLevel = assessment?.riskLevel ?? 2
    const { action } = this.decisionEngine.decide({ mode: context.mode, riskLevel, known: !!assessment, critical: riskLevel === 4, explicitRule })
    return assessmentDecision(assessment ?? { riskLevel, ruleId: 'unknown.command', reason: '未能可靠归类命令' }, pattern, action)
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
      allowedScopes: allowedScopesForRisk(decision.riskLevel)
    }
  }

  async rememberApproval(request: PermissionRequest, response: PermissionApprovalResponse, context: PermissionEvaluationContext): Promise<void> {
    if (!response.approved || response.scope === 'once' || request.riskLevel === 4) return
    await getPermissionRuleStore().remember({ workspaceRoot: context.workspaceRoot, sessionId: context.sessionId, pattern: request.normalizedPattern, action: 'allow', scope: response.scope, riskLevel: request.riskLevel })
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
