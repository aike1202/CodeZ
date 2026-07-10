import type { CommandAction, CommandAnalysis, CommandRisk } from './commandAnalysisTypes'
import { createCommandRuleOptions } from './commandRuleOptions'
import { DESTRUCTIVE_PREFIXES, NETWORK_PREFIXES, SAFE_PREFIXES, WRITE_PREFIXES } from './commandRiskRules'

export type { CommandAction, CommandAnalysis, CommandRisk, CommandRuleOption } from './commandAnalysisTypes'

export class CommandAnalyzer {
  private static readonly RISKY_OPERATOR_PATTERN = /[&<>`]/
  private static readonly COMMAND_SUBSTITUTION_PATTERN = /\$\s*\(/
  
  public static analyze(command: string): CommandRisk {
    return this.analyzeDetailed(command).risk
  }

  public static analyzeRule(rule: string): CommandRisk {
    const normalized = rule.trim().replace(/\s+\*$/, '')
    const exactRisk = this.analyze(normalized)
    if (exactRisk !== 'unknown') return exactRisk

    const lowerRule = normalized.toLowerCase()
    if (lowerRule === 'git') return 'network'
    if (lowerRule === 'npm' || lowerRule === 'yarn' || lowerRule === 'pnpm' || lowerRule === 'pip') return 'network'
    if (lowerRule === 'rm' || lowerRule === 'remove-item' || lowerRule === 'del') return 'destructive'
    return 'unknown'
  }

  public static analyzeDetailed(command: string): CommandAnalysis {
    const cmd = command.trim()
    const lowerCmd = cmd.toLowerCase()

    const sequenced = this.analyzeSequence(cmd)
    if (sequenced) return sequenced

    const multiline = this.analyzeMultiline(cmd)
    if (multiline) return multiline

    const piped = this.analyzePipeline(cmd)
    if (piped) return piped

    const conditional = this.analyzePowerShellIf(cmd)
    if (conditional) return conditional

    const assignment = this.analyzePowerShellAssignment(cmd)
    if (assignment) return assignment

    const dotNetIo = this.analyzeDotNetIoMethod(lowerCmd, cmd)
    if (dotNetIo) return dotNetIo

    const memberAccess = this.analyzePowerShellMemberAccess(cmd)
    if (memberAccess) return memberAccess

    const variableRead = this.analyzePowerShellVariableRead(cmd)
    if (variableRead) return variableRead

    const gitRead = this.analyzeGitRead(lowerCmd, cmd)
    if (gitRead) return gitRead

    if (this.hasUnsafePowerShellSyntax(cmd)) {
      return this.createAnalysis(cmd, 'destructive', 'unknown', false)
    }

    if (this.matchesAnyPrefix(lowerCmd, DESTRUCTIVE_PREFIXES) || this.hasDestructiveFlags(lowerCmd)) {
      return this.createAnalysis(cmd, 'destructive', this.detectAction(lowerCmd), false)
    }

    if (this.matchesAnyPrefix(lowerCmd, SAFE_PREFIXES)) {
      if (lowerCmd.includes('-delete') || lowerCmd.includes('--exec')) {
        return this.createAnalysis(cmd, 'destructive', 'delete', false)
      }
      return this.createAnalysis(cmd, 'safe', this.detectAction(lowerCmd), true)
    }

    if (this.matchesAnyPrefix(lowerCmd, NETWORK_PREFIXES)) {
      return this.createAnalysis(cmd, 'network', this.detectAction(lowerCmd), true)
    }

    if (this.matchesAnyPrefix(lowerCmd, WRITE_PREFIXES)) {
      return this.createAnalysis(cmd, 'write', this.detectAction(lowerCmd), true)
    }

    return this.createAnalysis(cmd, 'unknown', this.detectAction(lowerCmd), false)
  }

  private static createAnalysis(
    command: string,
    risk: CommandRisk,
    action: CommandAction,
    includeBroadRules: boolean
  ): CommandAnalysis {
    return {
      risk,
      action,
      reason: this.describeRisk(command, risk, action),
      impacts: this.detectImpacts(command, risk, action),
      ruleOptions: createCommandRuleOptions(command, risk, action, includeBroadRules)
    }
  }

  private static describeRisk(command: string, risk: CommandRisk, action: CommandAction): string {
    if ((command.includes(';') || command.trim().toLowerCase().startsWith('if ')) && risk === 'safe') return '条件分支和每个语句都被判定为只读查询或文本输出。'
    if (command.includes('|') && risk === 'safe') return '管道中的每一段都被判定为只读展示或查询。'
    if (this.hasUnsafePowerShellSyntax(command)) return '包含重定向、命令替换或调用操作符，可能组合执行多个动作。'
    if (risk === 'destructive') return '检测到删除、强制覆盖、进程控制或系统级操作。'
    if (risk === 'network') return '检测到联网、下载、安装依赖或远端仓库交互。'
    if (risk === 'write') return action === 'git' ? '检测到会修改 Git 状态的操作。' : '检测到会修改工作区文件或生成构建产物的操作。'
    if (risk === 'safe') return '检测结果为只读或信息查询，不应修改文件系统。'
    return '未能可靠归类该命令，按未知风险处理。'
  }

  private static detectImpacts(command: string, risk: CommandRisk, action: CommandAction): string[] {
    const lowerCommand = command.toLowerCase()
    const impacts = new Set<string>()
    if (risk === 'safe') impacts.add('只读查询')
    if (risk === 'write') impacts.add('工作区文件')
    if (risk === 'network' || action === 'network') impacts.add('外部网络')
    if (action === 'git' || lowerCommand.startsWith('git ')) impacts.add('Git 状态')
    if (action === 'delete' || risk === 'destructive') impacts.add('文件/进程/系统状态')
    if (lowerCommand.includes('npm') || lowerCommand.includes('pip') || lowerCommand.includes('yarn') || lowerCommand.includes('pnpm')) impacts.add('依赖环境')
    return Array.from(impacts)
  }

  private static detectAction(lowerCommand: string): CommandAction {
    if (lowerCommand.startsWith('git ')) return lowerCommand.startsWith('git status') || lowerCommand.startsWith('git log') || lowerCommand.startsWith('git diff') || lowerCommand.startsWith('git show') ? 'read' : 'git'
    if (lowerCommand.startsWith('curl') || lowerCommand.startsWith('wget') || lowerCommand.startsWith('invoke-webrequest') || lowerCommand.startsWith('invoke-restmethod')) return 'network'
    if (lowerCommand.startsWith('npm install') || lowerCommand.startsWith('npm i') || lowerCommand.startsWith('npm ci') || lowerCommand.startsWith('yarn add') || lowerCommand.startsWith('yarn install') || lowerCommand.startsWith('pnpm install') || lowerCommand.startsWith('pip install') || lowerCommand.startsWith('python -m pip install')) return 'network'
    if (lowerCommand.startsWith('rm') || lowerCommand.startsWith('rmdir') || lowerCommand.startsWith('rd') || lowerCommand.startsWith('remove-item') || lowerCommand.startsWith('del') || lowerCommand.startsWith('docker rm') || lowerCommand.startsWith('kubectl delete')) return 'delete'
    if (lowerCommand.startsWith('systemctl') || lowerCommand.startsWith('stop-process') || lowerCommand.startsWith('kill')) return 'service'
    if (this.matchesAnyPrefix(lowerCommand, SAFE_PREFIXES)) return 'read'
    return 'modify'
  }

  private static analyzePipeline(command: string): CommandAnalysis | null {
    if (!command.includes('|')) return null
    const segments = this.splitTopLevel(command, '|')
    if (segments.length < 2) return null

    const analyses = segments.map(segment => this.analyzeDetailed(segment))
    const highest = analyses.reduce((current, next) => this.compareRisk(current.risk, next.risk) >= 0 ? current : next)
    const safePipeline = analyses.every(analysis => analysis.risk === 'safe')
    return this.createAnalysis(command, safePipeline ? 'safe' : highest.risk, safePipeline ? 'read' : highest.action, safePipeline)
  }

  private static analyzeSequence(command: string): CommandAnalysis | null {
    if (!command.includes(';')) return null
    const segments = this.splitTopLevel(command, ';')
    if (segments.length < 2) return null
    const analyses = segments.map(segment => this.analyzeDetailed(segment))
    const highest = analyses.reduce((current, next) => this.compareRisk(current.risk, next.risk) >= 0 ? current : next)
    const safeSequence = analyses.every(analysis => analysis.risk === 'safe')
    return this.createAnalysis(command, safeSequence ? 'safe' : highest.risk, safeSequence ? 'read' : highest.action, safeSequence)
  }

  private static analyzeMultiline(command: string): CommandAnalysis | null {
    if (!command.includes('\n') && !command.includes('\r')) return null
    const segments = this.splitTopLevel(command.replace(/\r\n/g, '\n'), '\n')
    if (segments.length < 2) return null
    const analyses = segments.map(segment => this.analyzeDetailed(segment))
    const highest = analyses.reduce((current, next) => this.compareRisk(current.risk, next.risk) >= 0 ? current : next)
    const safeSequence = analyses.every(analysis => analysis.risk === 'safe')
    return this.createAnalysis(command, safeSequence ? 'safe' : highest.risk, safeSequence ? 'read' : highest.action, safeSequence)
  }

  private static analyzePowerShellIf(command: string): CommandAnalysis | null {
    const match = command.match(/^if\s*\((.+)\)\s*\{(.+)\}(?:\s*else\s*\{(.+)\})?$/is)
    if (!match) return null
    const [, condition, thenBody, elseBody] = match
    const analyses = [condition, thenBody, elseBody]
      .filter((part): part is string => typeof part === 'string')
      .map(part => this.analyzePowerShellSnippet(part.trim()))
    const highest = analyses.reduce((current, next) => this.compareRisk(current.risk, next.risk) >= 0 ? current : next)
    const safeIf = analyses.every(analysis => analysis.risk === 'safe')
    return this.createAnalysis(command, safeIf ? 'safe' : highest.risk, safeIf ? 'read' : highest.action, safeIf)
  }

  private static analyzePowerShellSnippet(snippet: string): CommandAnalysis {
    const trimmed = snippet.trim()
    const negated = trimmed.match(/^-not\s+\((.+)\)$/is) || trimmed.match(/^!\s*\((.+)\)$/is)
    if (negated) {
      return this.analyzePowerShellSnippet(negated[1].trim())
    }
    if (/^(['"]).*\1$/.test(trimmed)) {
      return this.createAnalysis(trimmed, 'safe', 'read', true)
    }
    return this.analyzeDetailed(trimmed)
  }

  private static analyzePowerShellAssignment(command: string): CommandAnalysis | null {
    const nullAssignment = command.match(/^\$null\s*=\s*(.+)$/is)
    if (nullAssignment) {
      return this.analyzeDetailed(nullAssignment[1].trim())
    }
    if (/^\[[^\r\n]+\]\s*\$[\w:]+\s*=/.test(command)) {
      return this.createAnalysis(command, 'safe', 'read', true)
    }
    if (/^\$[\w:]+\s*=/.test(command)) {
      return this.createAnalysis(command, 'destructive', 'modify', false)
    }
    return null
  }

  private static analyzeDotNetIoMethod(lowerCommand: string, command: string): CommandAnalysis | null {
    const match = lowerCommand.match(/^\[(?:system\.)?io\.(file|directory|path)\]::([a-z]\w*)\s*\(/)
    if (!match) return null

    const [, target, method] = match
    const destructiveMethods = new Set(['delete'])
    const writeMethods = new Set([
      'appendalllines', 'appendalltext', 'appendtext',
      'copy', 'create', 'createtext', 'move', 'openwrite', 'replace',
      'setattributes', 'setcreationtime', 'setcreationtimeutc',
      'setlastaccesstime', 'setlastaccesstimeutc', 'setlastwritetime', 'setlastwritetimeutc',
      'writeallbytes', 'writealllines', 'writealltext'
    ])
    const directoryWriteMethods = new Set(['createdirectory', 'move'])

    if (destructiveMethods.has(method)) {
      return this.createAnalysis(command, 'destructive', 'delete', false)
    }
    if (target === 'directory' && directoryWriteMethods.has(method)) {
      return this.createAnalysis(command, 'write', 'modify', true)
    }
    if (target === 'file' && writeMethods.has(method)) {
      return this.createAnalysis(command, 'write', 'modify', true)
    }
    return this.createAnalysis(command, 'safe', 'read', true)
  }

  private static analyzePowerShellMemberAccess(command: string): CommandAnalysis | null {
    const match = command.match(/^\((.+)\)\.[A-Za-z_]\w*$/is)
    if (!match) return null
    const inner = this.analyzePowerShellSnippet(match[1].trim())
    if (inner.risk === 'safe') {
      return this.createAnalysis(command, 'safe', 'read', true)
    }
    return null
  }

  private static analyzePowerShellVariableRead(command: string): CommandAnalysis | null {
    if (/^\$[\w:]+(?:\.[A-Za-z_]\w*)*$/.test(command)) {
      return this.createAnalysis(command, 'safe', 'read', true)
    }
    return null
  }

  private static analyzeGitRead(lowerCommand: string, command: string): CommandAnalysis | null {
    if (lowerCommand === 'git branch') {
      return this.createAnalysis(command, 'safe', 'read', true)
    }
    if (/^git config\s+(?:--get|get)\s+\S+/.test(lowerCommand) || /^git config\s+\S+$/.test(lowerCommand)) {
      return this.createAnalysis(command, 'safe', 'read', true)
    }
    if (lowerCommand === 'git config --list') {
      return this.createAnalysis(command, 'safe', 'read', true)
    }
    return null
  }

  private static splitTopLevel(command: string, delimiter: string): string[] {
    const parts: string[] = []
    let depth = 0
    let quote: string | null = null
    let current = ''
    for (const char of command) {
      if ((char === '\'' || char === '"') && quote === null) quote = char
      else if (char === quote) quote = null
      if (!quote) {
        if (char === '{' || char === '(') depth++
        if (char === '}' || char === ')') depth--
      }
      if (char === delimiter && depth === 0 && !quote) {
        parts.push(current.trim())
        current = ''
      } else {
        current += char
      }
    }
    if (current.trim()) parts.push(current.trim())
    return parts
  }

  private static compareRisk(left: CommandRisk, right: CommandRisk): number {
    const rank: Record<CommandRisk, number> = { safe: 0, write: 1, network: 2, unknown: 3, destructive: 4 }
    return rank[left] - rank[right]
  }

  private static matchesAnyPrefix(lowerCommand: string, prefixes: string[]): boolean {
    return prefixes.some(prefix => {
      const lowerPrefix = prefix.toLowerCase()
      return lowerCommand === lowerPrefix || lowerCommand.startsWith(`${lowerPrefix} `)
    })
  }

  private static hasDestructiveFlags(lowerCommand: string): boolean {
    const hasFlag = /\s--force(?:\s|$)/.test(lowerCommand)
      || /\s--force-with-lease(?:\s|$)/.test(lowerCommand)
      || /\s-recurse(?:\s|$)/.test(lowerCommand)
      || /\s-rf(?:\s|$)/.test(lowerCommand)
    if (!hasFlag) return false
    return /^(?:rm|rmdir|rd|remove-item|del|git push|git reset|git clean|docker rm|docker rmi|kubectl delete|stop-process|kill|taskkill)(?:\s|$)/.test(lowerCommand)
  }

  private static hasUnsafePowerShellSyntax(command: string): boolean {
    return this.RISKY_OPERATOR_PATTERN.test(command) || this.COMMAND_SUBSTITUTION_PATTERN.test(command)
  }
}
