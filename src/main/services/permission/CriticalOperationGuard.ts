import type { PermissionDecision, PermissionImpact } from '../../../shared/types/permission'
import { ShellAnalysisService } from './ShellAnalysisService'
import type { PermissionShellKind } from './operationTypes'
import { classifyKnownCommand } from './commandPolicies'
import * as os from 'os'
import * as path from 'path'

interface CriticalPattern {
  id: string
  pattern: RegExp
  reason: string
  impact: PermissionImpact['kind']
}

const PATTERNS: CriticalPattern[] = [
  { id: 'critical.privilege.sudo', pattern: /(?:^|[;&|\n]\s*)sudo\b|\bStart-Process\b[^\n]*-Verb\s+RunAs/i, reason: '请求管理员或根权限', impact: 'system' },
  { id: 'critical.delete.system-root', pattern: /\brm\s+(?:-[^\s]+\s+)*(?:["']?\/(?:["']?|\s|$)|["']?\/(?:etc|usr|var|bin|sbin|boot|lib)(?:\/|["']|\s|$))/i, reason: '递归删除系统根目录或系统目录', impact: 'system' },
  { id: 'critical.delete.home', pattern: /\brm\s+(?:-[^\s]+\s+)*(?:["']?(?:~|\$\{?HOME\}?)(?:\/|["']|\s|$))/i, reason: '删除用户主目录', impact: 'credential' },
  { id: 'critical.disk.format', pattern: /\b(?:mkfs(?:\.\w+)?|format\s+[a-z]:)\b/i, reason: '格式化文件系统', impact: 'system' },
  { id: 'critical.disk.partition', pattern: /\b(?:diskpart|fdisk|parted)\b/i, reason: '修改磁盘分区', impact: 'system' },
  { id: 'critical.disk.raw-write', pattern: /\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|hd|mmcblk|vd|xvd)|>\s*\/dev\/(?:sd|nvme|hd|mmcblk|vd|xvd)/i, reason: '直接写入块设备', impact: 'system' },
  { id: 'critical.remote.execute', pattern: /\b(?:curl|wget)\b[^|]*\|\s*(?:bash|sh|zsh)|Invoke-Expression[^\n]*(?:Invoke-WebRequest|Invoke-RestMethod)/i, reason: '下载或获取远程内容后直接执行', impact: 'network' },
  { id: 'critical.hidden.encoded-command', pattern: /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*-(?:encodedcommand|enc)\b|\b(?:base64|xxd|openssl)\b[^|]*\|\s*(?:bash|sh|zsh)/i, reason: '编码或解码后隐藏执行', impact: 'system' },
  { id: 'critical.process.host-shutdown', pattern: /(?:^|[;&|\n]\s*)(?:shutdown|reboot|halt|poweroff)\b|systemctl\s+(?:poweroff|reboot|halt)/i, reason: '关闭或重启主机', impact: 'process' },
  { id: 'critical.process.fork-bomb', pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'Shell fork bomb', impact: 'process' },
  { id: 'critical.credential.access', pattern: /(?:>|tee\s+|set-content\s+|remove-item\s+).*(?:\.ssh|\.aws|\.npmrc|\.pypirc|\.netrc|\.bashrc|\.zshrc)/i, reason: '修改凭据或启动配置', impact: 'credential' }
]

export class CriticalOperationGuard {
  async analyzeRaw(shell: PermissionShellKind, command: string, workspaceRoot: string): Promise<PermissionDecision | null> {
    const graph = await new ShellAnalysisService().parse(shell, command)
    for (const operation of graph.operations) {
      const known = classifyKnownCommand(operation.argv)
      if (known?.riskLevel === 4) return this.decision(known.ruleId, known.reason, command, 'git-remote')
      const criticalDelete = this.criticalDeleteTarget(operation.argv, workspaceRoot)
      if (criticalDelete) return criticalDelete
      if (operation.dynamic && graph.diagnostics.length > 0) return this.decision('critical.hidden.dynamic-command', '命令结构无法可靠解析', command, 'system')
    }
    for (const rule of PATTERNS) {
      if (rule.pattern.test(command)) return this.decision(rule.id, rule.reason, command, rule.impact)
    }
    return null
  }

  private criticalDeleteTarget(argv: string[], workspaceRoot: string): PermissionDecision | null {
    const executable = (argv[0] || '').toLowerCase().replace(/\.exe$/, '')
    if (!['rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'ri'].includes(executable)) return null
    const targets = argv.slice(1).filter((arg) => arg && !arg.startsWith('-') && !arg.startsWith('/q') && !arg.startsWith('/s'))
    for (const target of targets) {
      const normalizedTarget = target.replace(/\\/g, '/').replace(/["']/g, '')
      if (/^(?:[a-z]:)?\/(?:windows|program files(?: \(x86\))?|programdata|users)(?:\/|\*|$)/i.test(normalizedTarget)) {
        return this.decision('critical.delete.system-root', '删除 Windows 系统或用户目录', target, 'system')
      }
      if (/^(?:~|\$\{?home\}?)(?:\/|$)/i.test(normalizedTarget)) {
        return this.decision('critical.delete.home', '删除用户主目录', target, 'credential')
      }
      const resolved = path.resolve(workspaceRoot, target)
      const normalize = (value: string) => path.resolve(value).replace(/\\/g, '/').toLowerCase()
      if (normalize(resolved) === normalize(workspaceRoot)) {
        return this.decision('critical.delete.workspace-root', '删除整个工作区', target, 'workspace')
      }
      if (normalize(resolved) === normalize(os.homedir())) {
        return this.decision('critical.delete.home', '删除用户主目录', target, 'credential')
      }
    }
    return null
  }

  private decision(ruleId: string, reason: string, command: string, kind: PermissionImpact['kind']): PermissionDecision {
    return {
      action: 'ask',
      riskLevel: 4,
      reason,
      ruleId,
      normalizedPattern: command.trim(),
      impacts: [{ kind, target: command.trim() }],
      snapshots: [],
      critical: true
    }
  }
}
