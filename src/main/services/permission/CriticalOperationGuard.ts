import type { PermissionDecision, PermissionImpact } from '../../../shared/types/permission'
import { ShellAnalysisService } from './ShellAnalysisService'
import type { PermissionShellKind } from './operationTypes'
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
  { id: 'critical.remote.execute', pattern: /\b(?:curl|wget)\b[^|]*\|\s*(?:bash|sh|zsh)|\b(?:invoke-expression|iex)\b[^\n]*(?:invoke-webrequest|invoke-restmethod|iwr|irm)|\b(?:invoke-webrequest|invoke-restmethod|iwr|irm)\b[^|]*\|\s*(?:invoke-expression|iex)\b/i, reason: '下载或获取远程内容后直接执行', impact: 'network' },
  { id: 'critical.hidden.encoded-command', pattern: /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*-(?:encodedcommand|enc|e)\b|\b(?:base64|xxd|openssl)\b[^|]*\|\s*(?:bash|sh|zsh)/i, reason: '编码或解码后隐藏执行', impact: 'system' },
  { id: 'critical.permission-config.write', pattern: /(?:>|>>|\btee\b|\bset-content\b|\badd-content\b|\bout-file\b|\bremove-item\b|\brm\b|\bdel\b)[^\n]*(?:[\\/]codez[\\/](?:permission-rules|workspace-permissions)\.json)\b/i, reason: '修改 CodeZ 权限配置', impact: 'system' },
  { id: 'critical.process.host-shutdown', pattern: /(?:^|[;&|\n]\s*)(?:shutdown|reboot|halt|poweroff)\b|systemctl\s+(?:poweroff|reboot|halt)/i, reason: '关闭或重启主机', impact: 'process' },
  { id: 'critical.process.fork-bomb', pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'Shell fork bomb', impact: 'process' },
  { id: 'critical.credential.access', pattern: /(?:>|tee\s+|set-content\s+|remove-item\s+).*(?:\.ssh|\.aws|\.npmrc|\.pypirc|\.netrc|\.bashrc|\.zshrc)/i, reason: '修改凭据或启动配置', impact: 'credential' }
]

interface CriticalMutation {
  id: string
  reason: string
  impact: PermissionImpact['kind']
}

function criticalSystemMutation(argv: string[]): CriticalMutation | null {
  const executable = (argv[0] || '').toLowerCase().replace(/\.exe$/, '')
  const args = argv.slice(1).map((arg) => arg.toLowerCase())
  const subcommand = args[0] || ''
  if (executable === 'systemctl' && ['enable', 'disable', 'mask', 'unmask', 'start', 'stop', 'restart', 'reload', 'edit', 'daemon-reload'].includes(subcommand)) {
    return { id: 'critical.system.service', reason: '修改系统服务', impact: 'system' }
  }
  if (executable === 'sc' && ['config', 'create', 'delete', 'start', 'stop', 'failure', 'privs', 'sidtype'].includes(subcommand)) {
    return { id: 'critical.system.service', reason: '修改 Windows 系统服务', impact: 'system' }
  }
  if (['set-service', 'new-service', 'remove-service', 'restart-service', 'stop-service', 'start-service'].includes(executable)) {
    return { id: 'critical.system.service', reason: '修改 Windows 系统服务', impact: 'system' }
  }
  if (['useradd', 'userdel', 'usermod', 'groupadd', 'groupdel', 'groupmod', 'passwd', 'chpasswd'].includes(executable)) {
    return { id: 'critical.system.account', reason: '修改系统账户或用户组', impact: 'system' }
  }
  if (executable === 'net' && ['user', 'localgroup', 'group'].includes(subcommand) && (args.length >= 3 || args.some((arg) => ['/add', '/delete', '/active:yes', '/active:no'].includes(arg)))) {
    return { id: 'critical.system.account', reason: '修改 Windows 账户或用户组', impact: 'system' }
  }
  if (['new-localuser', 'remove-localuser', 'set-localuser', 'add-localgroupmember', 'remove-localgroupmember'].includes(executable)) {
    return { id: 'critical.system.account', reason: '修改 Windows 账户或用户组', impact: 'system' }
  }
  if (['set-mppreference', 'add-mppreference', 'remove-mppreference', 'secedit'].includes(executable) ||
      (executable === 'netsh' && args[0] === 'advfirewall' && args.includes('set')) ||
      ['set-netfirewallprofile', 'set-netfirewallrule', 'new-netfirewallrule', 'remove-netfirewallrule'].includes(executable)) {
    return { id: 'critical.system.security-policy', reason: '修改系统安全策略', impact: 'system' }
  }
  if (executable === 'schtasks' && args.some((arg) => ['/create', '/change', '/delete'].includes(arg))) {
    return { id: 'critical.startup.persistence', reason: '修改计划任务或启动持久化', impact: 'system' }
  }
  if (executable === 'reg' && ['add', 'delete'].includes(subcommand) && /\/currentversion\/(?:run|runonce)(?:\/|\s|$)/i.test(argv.join(' ').replace(/\\/g, '/'))) {
    return { id: 'critical.startup.persistence', reason: '修改注册表启动项', impact: 'system' }
  }
  if (executable === 'crontab' && args.length > 0 && !args.every((arg) => ['-l', '--list'].includes(arg))) {
    return { id: 'critical.startup.persistence', reason: '修改定时任务或启动持久化', impact: 'system' }
  }
  return null
}

function criticalPrivilegeEscalation(argv: string[]): CriticalMutation | null {
  let executable = (argv[0] || '').toLowerCase().replace(/\.exe$/, '')
  let args = argv.slice(1)
  let wrappedByEnv = false
  if (executable === 'env') {
    wrappedByEnv = true
    let index = 0
    while (index < args.length) {
      const argument = args[index]
      if (['-u', '--unset', '-C', '--chdir'].includes(argument)) {
        index += 2
        continue
      }
      if (argument === '--') {
        index++
        break
      }
      if (argument.startsWith('-') || /^[A-Za-z_]\w*=/.test(argument)) {
        index++
        continue
      }
      break
    }
    executable = (args[index] || '').toLowerCase().replace(/\.exe$/, '')
    args = args.slice(index + 1)
  }
  if (['pkexec', 'doas', 'runas'].includes(executable) || (wrappedByEnv && executable === 'sudo')) {
    return { id: 'critical.privilege.escalation', reason: '请求管理员或根权限', impact: 'system' }
  }
  if (executable === 'su') {
    return { id: 'critical.privilege.escalation', reason: '请求管理员或根权限', impact: 'system' }
  }
  return null
}

function packageCredentialMutation(argv: string[]): boolean {
  const executable = (argv[0] || '').toLowerCase().replace(/\.exe$/, '')
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) return false
  let index = 1
  const directoryOption = argv[index]
  const hasDirectoryOption =
    (executable === 'npm' && directoryOption === '--prefix') ||
    (executable === 'pnpm' && ['-C', '--dir'].includes(directoryOption)) ||
    (['yarn', 'bun'].includes(executable) && directoryOption === '--cwd')
  if (hasDirectoryOption && argv[index + 1]) index += 2
  const command = (argv[index] || '').toLowerCase()
  const mutation = command === 'config' ? (argv[index + 1] || '').toLowerCase() : command
  if (!['set', 'delete', 'unset'].includes(mutation)) return false
  const keyIndex = command === 'config' ? index + 2 : index + 1
  const key = argv[keyIndex] || ''
  const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return normalizedKey === 'auth' || normalizedKey === 'token' ||
    ['authtoken', 'authident', 'password', 'passwd'].some((suffix) => normalizedKey.endsWith(suffix))
}

function hasDynamicEvaluator(argv: string[]): boolean {
  const executable = (argv[0] || '').toLowerCase().replace(/\.exe$/, '')
  if (!['eval', 'invoke-expression', 'iex'].includes(executable)) return false
  const expression = argv.slice(1).join(' ').trim()
  return /(?:^|\s)(?:\$[A-Za-z_]\w*|\$\{[^}]+\}|\$\(.+\)|`.+`|%[^%]+%|![^!]+!)(?:\s|$)/.test(expression)
}

function gitInvocation(argv: string[]): string[] | null {
  const executable = (argv[0] || '').toLowerCase().replace(/\.exe$/, '')
  if (executable !== 'git') return null
  let index = 1
  while (index < argv.length) {
    const argument = argv[index]
    const lower = argument.toLowerCase()
    if (lower === '-c' || ['--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(lower)) {
      index += 2
      continue
    }
    if (/^(?:-c.+|--(?:git-dir|work-tree|namespace|exec-path)=.+)$/i.test(argument)) {
      index++
      continue
    }
    if (argument.startsWith('-')) {
      index++
      continue
    }
    return argv.slice(index)
  }
  return []
}

function isForcePushArgument(argument: string): boolean {
  const lower = argument.toLowerCase()
  return ['--force', '-f', '--force-with-lease', '--force-if-includes', '--mirror'].includes(lower) ||
    /^-[^-]*f/i.test(argument) ||
    /^--force(?:-with-lease|-if-includes)?=/.test(lower) ||
    /^\+[^+]/.test(argument)
}

const PERMISSION_CONFIG_READ_COMMANDS = new Set([
  'cat', 'type', 'more', 'less', 'head', 'tail', 'stat', 'ls', 'dir', 'rg', 'grep',
  'get-content', 'get-item', 'test-path', 'resolve-path', 'select-string'
])

function referencesPermissionConfig(source: string): boolean {
  return /[\\/]codez[\\/](?:permission-rules|workspace-permissions)\.json\b/i.test(source)
}

function isShellWrapper(argv: string[]): boolean {
  const executable = (argv[0] || '').toLowerCase().replace(/\.exe$/, '')
  return ['bash', 'sh', 'zsh', 'powershell', 'pwsh', 'cmd'].includes(executable)
}

function hasDynamicNestedCommand(argv: string[]): boolean {
  const executable = (argv[0] || '').toLowerCase().replace(/\.exe$/, '')
  let body = ''
  if (['bash', 'sh', 'zsh'].includes(executable)) {
    const index = argv.findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(arg))
    if (index < 0) return false
    body = argv[index + 1] || ''
  } else if (['powershell', 'pwsh'].includes(executable)) {
    const index = argv.findIndex((arg) => /^-(?:command|c)$/i.test(arg))
    if (index < 0) return false
    body = argv.slice(index + 1).join(' ')
  } else if (executable === 'cmd') {
    const index = argv.findIndex((arg) => /^\/(?:c|k)$/i.test(arg))
    if (index < 0) return false
    body = argv.slice(index + 1).join(' ')
  } else {
    return false
  }
  const normalized = body.trim()
  return /^(?:\$[A-Za-z_]\w*|\$\{[^}]+\}|\$\(.+\)|`.+`|&\s*\$[A-Za-z_]\w*|%[^%]+%|![^!]+!)$/.test(normalized)
}

export class CriticalOperationGuard {
  async analyzeRaw(shell: PermissionShellKind, command: string, workspaceRoot: string): Promise<PermissionDecision | null> {
    const graph = await new ShellAnalysisService().parse(shell, command)
    const hasRemoteFetch = graph.operations.some((operation) => ['invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm'].includes((operation.argv[0] || '').toLowerCase()))
    const hasExpressionEvaluator = graph.operations.some((operation) => ['invoke-expression', 'iex'].includes((operation.argv[0] || '').toLowerCase()))
    if (graph.operators.includes('|') && hasRemoteFetch && hasExpressionEvaluator) {
      return this.decision('critical.remote.execute', '下载或获取远程内容后直接执行', command, 'network')
    }
    for (const operation of graph.operations) {
      const gitArgs = gitInvocation(operation.argv)?.map((arg) => arg.toLowerCase())
      if (gitArgs?.[0] === 'push' && gitArgs.slice(1).some(isForcePushArgument)) {
        return this.decision('critical.git.force-push', '强制改写远端历史', command, 'git-remote')
      }
      if ((operation.dynamic && graph.diagnostics.length === 0) || hasDynamicNestedCommand(operation.argv)) {
        return this.decision('critical.hidden.dynamic-command', '动态生成或隐藏执行命令', command, 'system')
      }
      if (hasDynamicEvaluator(operation.argv)) {
        return this.decision('critical.hidden.dynamic-command', '动态生成或隐藏执行命令', command, 'system')
      }
      const privilegeEscalation = criticalPrivilegeEscalation(operation.argv)
      if (privilegeEscalation) return this.decision(privilegeEscalation.id, privilegeEscalation.reason, command, privilegeEscalation.impact)
      if (packageCredentialMutation(operation.argv)) {
        return this.decision('critical.credential.access', '修改包管理器凭据配置', command, 'credential')
      }
      const systemMutation = criticalSystemMutation(operation.argv)
      if (systemMutation) return this.decision(systemMutation.id, systemMutation.reason, command, systemMutation.impact)
      const executable = (operation.argv[0] || '').toLowerCase().replace(/\.exe$/, '')
      if (referencesPermissionConfig(operation.source) && !PERMISSION_CONFIG_READ_COMMANDS.has(executable) && !isShellWrapper(operation.argv)) {
        return this.decision('critical.permission-config.write', '修改 CodeZ 权限配置', command, 'system')
      }
      const criticalDelete = this.criticalDeleteTarget(operation.argv, workspaceRoot)
      if (criticalDelete) return criticalDelete
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
      if (/^[a-z]:\/(?:\*.*)?$/i.test(normalizedTarget)) {
        return this.decision('critical.delete.system-root', '删除 Windows 磁盘根目录', target, 'system')
      }
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
      permission: 'hardline',
      checks: [{ permission: 'hardline', pattern: command.trim(), action: 'ask', reason }],
      analysisStatus: 'parsed',
      hardline: true,
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
