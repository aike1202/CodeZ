import type { PermissionRiskLevel } from '../../../shared/types/permission'

export interface CommandAssessment {
  riskLevel: PermissionRiskLevel
  ruleId: string
  reason: string
}

const READ_COMMANDS = new Set(['ls', 'dir', 'pwd', 'which', 'where', 'cat', 'head', 'tail', 'grep', 'rg', 'findstr', 'get-content', 'get-childitem', 'get-location', 'test-path'])
const BUILD_COMMANDS = new Set(['make', 'cmake', 'ninja', 'pytest', 'vitest', 'jest', 'go', 'dotnet', 'mvn', 'gradle', 'cargo'])
const VERSION_FLAGS = new Set(['--version', '-version', '-v', 'version'])

export function classifyKnownCommand(argv: string[]): CommandAssessment | null {
  const executable = (argv[0] || '').toLowerCase().replace(/\.exe$/, '')
  const subcommand = (argv[1] || '').toLowerCase()
  const args = argv.slice(1).map((arg) => arg.toLowerCase())
  if (!executable) return null
  if (args.some((arg) => VERSION_FLAGS.has(arg)) || VERSION_FLAGS.has(subcommand)) return { riskLevel: 0, ruleId: `known.version.${executable}`, reason: '查看工具版本' }
  if (READ_COMMANDS.has(executable)) return { riskLevel: 0, ruleId: `known.read.${executable}`, reason: '只读查询命令' }
  if (executable === 'git') {
    if (['status', 'diff', 'log', 'show', 'branch', 'rev-parse'].includes(subcommand)) return { riskLevel: 0, ruleId: `known.git.${subcommand}`, reason: '只读 Git 操作' }
    if (subcommand === 'push' && args.some((arg) => ['--force', '-f', '--force-with-lease'].includes(arg))) return { riskLevel: 4, ruleId: 'critical.git.force-push', reason: '强制改写远端历史' }
    if ((subcommand === 'reset' && args.includes('--hard')) || (subcommand === 'clean' && args.some((arg) => arg.includes('f')))) return { riskLevel: 3, ruleId: `known.git.${subcommand}.destructive`, reason: '会丢弃本地 Git 状态' }
    if (subcommand === 'push' || subcommand === 'fetch' || subcommand === 'pull' || subcommand === 'clone') return { riskLevel: 2, ruleId: `known.git.${subcommand}.network`, reason: '访问远端 Git 仓库' }
    return { riskLevel: 1, ruleId: `known.git.${subcommand || 'write'}`, reason: '修改工作区 Git 状态' }
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) {
    if (['install', 'add', 'update', 'ci'].includes(subcommand)) return { riskLevel: 2, ruleId: `known.package.${executable}.${subcommand}`, reason: '安装依赖并访问网络' }
    return { riskLevel: 1, ruleId: `known.package.${executable}.script`, reason: '运行工作区开发脚本' }
  }
  if (['pip', 'pip3', 'uv'].includes(executable) && ['install', 'add', 'sync'].includes(subcommand)) return { riskLevel: 2, ruleId: `known.python.${executable}.${subcommand}`, reason: '安装 Python 依赖' }
  if (['python', 'python3', 'py'].includes(executable)) {
    if (subcommand === '-m' && ['pip', 'uv'].includes((argv[2] || '').toLowerCase()) && ['install', 'sync'].includes((argv[3] || '').toLowerCase())) return { riskLevel: 2, ruleId: 'known.python.module-install', reason: '安装 Python 依赖' }
    return { riskLevel: 1, ruleId: 'known.python.execute', reason: '运行工作区 Python 程序' }
  }
  if (executable === 'cargo') {
    if (['install', 'add', 'update'].includes(subcommand)) return { riskLevel: 2, ruleId: `known.rust.cargo.${subcommand}`, reason: '下载或安装 Rust 依赖' }
    return { riskLevel: 1, ruleId: `known.rust.cargo.${subcommand || 'build'}`, reason: '构建或测试 Rust 工作区' }
  }
  if (executable === 'go') {
    if (['get', 'install', 'mod'].includes(subcommand)) return { riskLevel: 2, ruleId: `known.go.${subcommand}`, reason: '下载 Go 依赖' }
    return { riskLevel: 1, ruleId: `known.go.${subcommand || 'build'}`, reason: '构建或测试 Go 工作区' }
  }
  if (['mvn', 'gradle', 'gradlew'].includes(executable)) return { riskLevel: 1, ruleId: `known.java.${executable}`, reason: '构建或测试 Java 工作区' }
  if (executable === 'dotnet') {
    if (subcommand === 'add' && args.includes('package')) return { riskLevel: 2, ruleId: 'known.dotnet.add-package', reason: '添加 .NET 依赖' }
    return { riskLevel: 1, ruleId: `known.dotnet.${subcommand || 'build'}`, reason: '构建或测试 .NET 工作区' }
  }
  if (['node', 'deno'].includes(executable)) return { riskLevel: 1, ruleId: `known.javascript.${executable}`, reason: '运行工作区 JavaScript 程序' }
  if (BUILD_COMMANDS.has(executable)) return { riskLevel: 1, ruleId: `known.build.${executable}`, reason: '构建或测试工作区' }
  if (['curl', 'wget', 'invoke-webrequest', 'invoke-restmethod'].includes(executable)) return { riskLevel: 2, ruleId: `known.network.${executable}`, reason: '访问外部网络' }
  if (['rm', 'rmdir', 'del', 'erase', 'remove-item', 'ri'].includes(executable)) return { riskLevel: 3, ruleId: `known.delete.${executable}`, reason: '删除文件或目录' }
  if (['docker', 'kubectl', 'helm'].includes(executable)) return { riskLevel: 2, ruleId: `known.platform.${executable}`, reason: '影响外部运行环境' }
  return null
}
