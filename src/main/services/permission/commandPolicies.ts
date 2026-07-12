import type { PermissionCapability, PermissionRiskLevel } from '../../../shared/types/permission'
import { normalizeExecutableName } from './executableName'

export interface CommandAssessment {
  permission: PermissionCapability
  riskLevel: PermissionRiskLevel
  ruleId: string
  reason: string
}

const READ_COMMANDS = new Set(['ls', 'dir', 'pwd', 'which', 'where', 'cat', 'head', 'tail', 'grep', 'rg', 'findstr', 'get-content', 'get-childitem', 'get-location', 'test-path'])
const BUILD_COMMANDS = new Set([
  'make', 'cmake', 'ninja', 'pytest', 'vitest', 'jest', 'go', 'dotnet', 'mvn', 'mvnw',
  'gradle', 'gradlew', 'ant', 'sbt', 'msbuild', 'xbuild', 'bazel', 'bazelisk', 'buck',
  'buck2', 'meson', 'xcodebuild', 'swift', 'cargo'
])
const VERSION_FLAGS = new Set(['--version', '-version', '-v'])
const PACKAGE_NETWORK_COMMANDS = new Set([
  'install', 'add', 'update', 'ci', 'remove', 'uninstall', 'audit', 'publish', 'unpublish',
  'login', 'logout', 'deprecate', 'dist-tag', 'access', 'owner', 'token', 'exec', 'x', 'dlx',
  'create', 'init'
])
const PYTHON_PROJECT_MANAGERS = new Set(['poetry', 'pdm', 'pipenv', 'rye', 'hatch'])
const PYTHON_PROJECT_NETWORK_COMMANDS = new Set([
  'add', 'install', 'lock', 'sync', 'update', 'upgrade', 'create', 'fetch'
])
const DATABASE_CLIENTS = new Set(['mysql', 'mysqlsh', 'psql', 'sqlcmd', 'mongosh', 'redis-cli'])

function isPureVersionQuery(executable: string, argv: string[]): boolean {
  const args = argv.slice(1).map((arg) => arg.toLowerCase())
  if (args.length !== 1) return false
  if (VERSION_FLAGS.has(args[0])) return true
  return args[0] === 'version' && executable === 'go'
}

function packageCommandArgs(executable: string, argv: string[]): string[] {
  const directoryOption = argv[1]
  const hasDirectoryOption =
    (executable === 'npm' && directoryOption === '--prefix') ||
    (executable === 'pnpm' && ['-C', '--dir'].includes(directoryOption)) ||
    (['yarn', 'bun'].includes(executable) && directoryOption === '--cwd')
  return argv.slice(hasDirectoryOption && argv[2] ? 3 : 1).map((argument) => argument.toLowerCase())
}

function isForcePushArgument(argument: string): boolean {
  const lower = argument.toLowerCase()
  return ['--force', '-f', '--force-with-lease', '--force-if-includes', '--mirror'].includes(lower) ||
    /^-[^-]*f/i.test(argument) ||
    /^--force(?:-with-lease|-if-includes)?=/.test(lower) ||
    /^\+[^+]/.test(argument)
}

function isGradlePublishTask(argument: string): boolean {
  const task = argument.split(':').pop() || ''
  return task.startsWith('publish') && task !== 'publishtomavenlocal'
}

export function classifyKnownCommand(argv: string[]): CommandAssessment | null {
  const executable = normalizeExecutableName(argv[0] || '')
  const packageArgs = ['npm', 'pnpm', 'yarn', 'bun'].includes(executable) ? packageCommandArgs(executable, argv) : []
  const subcommand = packageArgs[0] ?? (argv[1] || '').toLowerCase()
  const args = argv.slice(1).map((arg) => arg.toLowerCase())
  if (!executable) return null
  if (isPureVersionQuery(executable, argv)) return { permission: 'shell', riskLevel: 0, ruleId: `known.version.${executable}`, reason: '查看工具版本' }
  if (READ_COMMANDS.has(executable)) return { permission: 'shell', riskLevel: 0, ruleId: `known.read.${executable}`, reason: '只读查询命令' }
  if (executable === 'git') {
    if (['status', 'diff', 'log', 'show', 'branch', 'rev-parse'].includes(subcommand)) return { permission: 'shell', riskLevel: 0, ruleId: `known.git.${subcommand}`, reason: '只读 Git 操作' }
    if (subcommand === 'push' && argv.slice(2).some(isForcePushArgument)) return { permission: 'hardline', riskLevel: 4, ruleId: 'critical.git.force-push', reason: '强制改写远端历史' }
    if ((subcommand === 'reset' && args.includes('--hard')) || (subcommand === 'clean' && args.some((arg) => arg.includes('f')))) return { permission: 'delete', riskLevel: 3, ruleId: `known.git.${subcommand}.destructive`, reason: '会丢弃本地 Git 状态' }
    if (subcommand === 'push' || subcommand === 'fetch' || subcommand === 'pull' || subcommand === 'clone') return { permission: 'network', riskLevel: 2, ruleId: `known.git.${subcommand}.network`, reason: '访问远端 Git 仓库' }
    return { permission: 'shell', riskLevel: 1, ruleId: `known.git.${subcommand || 'write'}`, reason: '修改工作区 Git 状态' }
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) {
    const configMutation = subcommand === 'config' && ['set', 'delete', 'unset', 'edit'].includes(packageArgs[1] || '')
    if (configMutation || (executable === 'npm' && subcommand === 'set')) {
      return { permission: 'external_effect', riskLevel: 2, ruleId: `known.package.${executable}.config-write`, reason: '修改包管理器配置' }
    }
    if (PACKAGE_NETWORK_COMMANDS.has(subcommand)) return { permission: 'network', riskLevel: 2, ruleId: `known.package.${executable}.${subcommand}`, reason: '修改包或访问包服务' }
    if (subcommand === 'version') return { permission: 'external_effect', riskLevel: 1, ruleId: `known.package.${executable}.version`, reason: '修改包版本和本地 Git 状态' }
    return { permission: 'shell', riskLevel: 1, ruleId: `known.package.${executable}.script`, reason: '运行工作区开发命令' }
  }
  if (['npx', 'pnpx'].includes(executable)) return { permission: 'network', riskLevel: 2, ruleId: `known.package.${executable}.execute`, reason: '下载或执行 Node.js 包' }
  if (executable === 'corepack') {
    if (['npm', 'pnpm', 'yarn'].includes(subcommand)) return classifyKnownCommand(argv.slice(1))
    if (['install', 'prepare', 'use', 'up', 'enable', 'disable'].includes(subcommand)) return { permission: 'external_effect', riskLevel: 2, ruleId: `known.package.corepack.${subcommand}`, reason: '下载包管理器或修改全局代理' }
    return { permission: 'shell', riskLevel: 1, ruleId: 'known.package.corepack', reason: '查询 Corepack 状态' }
  }
  if (['pip', 'pip3', 'uv'].includes(executable) && ['install', 'add', 'sync', 'download', 'wheel'].includes(subcommand)) return { permission: 'network', riskLevel: 2, ruleId: `known.python.${executable}.${subcommand}`, reason: '下载或安装 Python 依赖' }
  if (['pip', 'pip3'].includes(executable) && subcommand === 'uninstall') return { permission: 'external_effect', riskLevel: 1, ruleId: `known.python.${executable}.uninstall`, reason: '修改 Python 运行环境' }
  if (['conda', 'mamba', 'micromamba'].includes(executable)) {
    if (['create', 'install', 'update', 'upgrade', 'search'].includes(subcommand)) return { permission: 'network', riskLevel: 2, ruleId: `known.python.${executable}.${subcommand}`, reason: '下载或更新 Python 环境依赖' }
    if (['remove', 'uninstall'].includes(subcommand)) return { permission: 'external_effect', riskLevel: 1, ruleId: `known.python.${executable}.${subcommand}`, reason: '修改 Python 环境' }
    return { permission: 'shell', riskLevel: 1, ruleId: `known.python.${executable}`, reason: '运行 Python 环境工具' }
  }
  if (PYTHON_PROJECT_MANAGERS.has(executable)) {
    if (subcommand === 'publish') return { permission: 'external_effect', riskLevel: 2, ruleId: `known.python.${executable}.publish`, reason: '发布 Python 包' }
    if (PYTHON_PROJECT_NETWORK_COMMANDS.has(subcommand)) return { permission: 'network', riskLevel: 2, ruleId: `known.python.${executable}.${subcommand}`, reason: '解析或下载 Python 项目依赖' }
    return { permission: 'shell', riskLevel: 1, ruleId: `known.python.${executable}`, reason: '运行 Python 项目工具' }
  }
  if (executable === 'pipx') {
    if (['install', 'upgrade', 'upgrade-all', 'inject', 'run'].includes(subcommand)) return { permission: 'network', riskLevel: 2, ruleId: `known.python.pipx.${subcommand}`, reason: '下载或运行 Python 工具' }
    return { permission: 'external_effect', riskLevel: 1, ruleId: `known.python.pipx.${subcommand || 'manage'}`, reason: '修改独立 Python 工具环境' }
  }
  if (executable === 'twine' && subcommand === 'upload') return { permission: 'external_effect', riskLevel: 2, ruleId: 'known.python.twine.upload', reason: '发布 Python 包' }
  if (['python', 'python3', 'py'].includes(executable)) {
    if (subcommand === '-m' && ['pip', 'uv'].includes((argv[2] || '').toLowerCase()) && ['install', 'sync'].includes((argv[3] || '').toLowerCase())) return { permission: 'network', riskLevel: 2, ruleId: 'known.python.module-install', reason: '安装 Python 依赖' }
    return { permission: 'shell', riskLevel: 1, ruleId: 'known.python.execute', reason: '运行工作区 Python 程序' }
  }
  if (executable === 'cargo') {
    if (['publish', 'login', 'logout', 'yank', 'owner'].includes(subcommand)) return { permission: 'external_effect', riskLevel: 2, ruleId: `known.rust.cargo.${subcommand}`, reason: '修改远端 Cargo 注册表状态' }
    if (['install', 'add', 'update', 'fetch', 'search'].includes(subcommand)) return { permission: 'network', riskLevel: 2, ruleId: `known.rust.cargo.${subcommand}`, reason: '下载依赖或访问 Cargo 注册表' }
    return { permission: 'shell', riskLevel: 1, ruleId: `known.rust.cargo.${subcommand || 'build'}`, reason: '构建或测试 Rust 工作区' }
  }
  if (executable === 'go') {
    if (['get', 'install', 'mod'].includes(subcommand)) return { permission: 'network', riskLevel: 2, ruleId: `known.go.${subcommand}`, reason: '下载 Go 依赖' }
    return { permission: 'shell', riskLevel: 1, ruleId: `known.go.${subcommand || 'build'}`, reason: '构建或测试 Go 工作区' }
  }
  if (['mvn', 'mvnw'].includes(executable)) {
    if (args.some((argument) => /(?:^|:)deploy(?:-file)?$/.test(argument))) {
      return { permission: 'external_effect', riskLevel: 2, ruleId: `known.java.${executable}.deploy`, reason: '发布 Maven 构建产物' }
    }
    if (args.includes('-u') || args.includes('--update-snapshots') || args.some((argument) => argument.startsWith('dependency:') || /maven-dependency-plugin(?::[^:]+)?:/.test(argument))) {
      return { permission: 'network', riskLevel: 2, ruleId: `known.java.${executable}.dependency`, reason: '下载 Maven 依赖' }
    }
    return { permission: 'shell', riskLevel: 1, ruleId: `known.java.${executable}`, reason: '构建或测试 Java 工作区' }
  }
  if (['gradle', 'gradlew'].includes(executable)) {
    if (args.some(isGradlePublishTask)) {
      return { permission: 'external_effect', riskLevel: 2, ruleId: `known.java.${executable}.publish`, reason: '发布 Gradle 构建产物' }
    }
    if (args.includes('--refresh-dependencies')) {
      return { permission: 'network', riskLevel: 2, ruleId: `known.java.${executable}.refresh-dependencies`, reason: '刷新 Gradle 依赖' }
    }
    return { permission: 'shell', riskLevel: 1, ruleId: `known.java.${executable}`, reason: '构建或测试 Java 工作区' }
  }
  if (executable === 'sbt' && args.some((argument) => ['update', 'reload', 'publish', 'publishsigned'].includes(argument))) {
    const external = args.some((argument) => ['publish', 'publishsigned'].includes(argument))
    return { permission: external ? 'external_effect' : 'network', riskLevel: 2, ruleId: `known.java.sbt.${external ? 'publish' : 'dependency'}`, reason: external ? '发布 SBT 构建产物' : '下载 SBT 依赖' }
  }
  if (['ant', 'sbt'].includes(executable)) return { permission: 'shell', riskLevel: 1, ruleId: `known.java.${executable}`, reason: '构建或测试 Java 工作区' }
  if (executable === 'dotnet') {
    if (subcommand === 'add' && args.includes('package')) return { permission: 'network', riskLevel: 2, ruleId: 'known.dotnet.add-package', reason: '添加 .NET 依赖' }
    if (subcommand === 'restore' || (['tool', 'workload'].includes(subcommand) && args.some((argument) => ['install', 'update', 'restore'].includes(argument)))) return { permission: 'network', riskLevel: 2, ruleId: `known.dotnet.${subcommand}.download`, reason: '下载 .NET 依赖或工具' }
    if (subcommand === 'nuget' && args.some((argument) => ['push', 'delete'].includes(argument))) return { permission: 'external_effect', riskLevel: 2, ruleId: 'known.dotnet.nuget.publish', reason: '修改远端 NuGet 包状态' }
    return { permission: 'shell', riskLevel: 1, ruleId: `known.dotnet.${subcommand || 'build'}`, reason: '构建或测试 .NET 工作区' }
  }
  if (['node', 'deno'].includes(executable)) return { permission: 'shell', riskLevel: 1, ruleId: `known.javascript.${executable}`, reason: '运行工作区 JavaScript 程序' }
  if (executable === 'rustup') {
    if (args.some((argument) => ['install', 'update', 'add'].includes(argument))) return { permission: 'network', riskLevel: 2, ruleId: 'known.rust.rustup.download', reason: '下载或更新 Rust 工具链组件' }
    return { permission: 'shell', riskLevel: 1, ruleId: 'known.rust.rustup', reason: '查询或管理 Rust 工具链' }
  }
  if (executable === 'composer') {
    if (['install', 'update', 'require', 'remove', 'create-project'].includes(subcommand)) return { permission: 'network', riskLevel: 2, ruleId: `known.php.composer.${subcommand}`, reason: '下载或修改 PHP 依赖' }
    return { permission: 'shell', riskLevel: 1, ruleId: 'known.php.composer', reason: '运行 Composer 命令' }
  }
  if (['bundle', 'bundler', 'gem'].includes(executable)) {
    if (executable === 'gem' && ['push', 'yank', 'owner'].includes(subcommand)) return { permission: 'external_effect', riskLevel: 2, ruleId: `known.ruby.gem.${subcommand}`, reason: '修改远端 RubyGems 状态' }
    if (['install', 'update'].includes(subcommand)) return { permission: 'network', riskLevel: 2, ruleId: `known.ruby.${executable}.${subcommand}`, reason: '下载或更新 Ruby 依赖' }
    return { permission: 'shell', riskLevel: 1, ruleId: `known.ruby.${executable}`, reason: '运行 Ruby 工具命令' }
  }
  if (['vcpkg', 'conan'].includes(executable)) {
    if (subcommand === 'upload') return { permission: 'external_effect', riskLevel: 2, ruleId: `known.cpp.${executable}.upload`, reason: '发布 C/C++ 包' }
    if (['install', 'update', 'upgrade', 'download', 'search'].includes(subcommand)) return { permission: 'network', riskLevel: 2, ruleId: `known.cpp.${executable}.${subcommand}`, reason: '下载或更新 C/C++ 依赖' }
    return { permission: 'shell', riskLevel: 1, ruleId: `known.cpp.${executable}`, reason: '运行 C/C++ 包管理工具' }
  }
  if (['dart', 'flutter'].includes(executable) && subcommand === 'pub') {
    const pubCommand = args[1] || ''
    if (pubCommand === 'publish') return { permission: 'external_effect', riskLevel: 2, ruleId: `known.dart.${executable}.publish`, reason: '发布 Dart 包' }
    if (['get', 'upgrade', 'add', 'cache'].includes(pubCommand)) return { permission: 'network', riskLevel: 2, ruleId: `known.dart.${executable}.pub.${pubCommand}`, reason: '下载或更新 Dart 依赖' }
  }
  if (executable === 'mix') {
    if (subcommand === 'hex.publish') return { permission: 'external_effect', riskLevel: 2, ruleId: 'known.elixir.hex.publish', reason: '发布 Hex 包' }
    if (['deps.get', 'deps.update', 'local.hex', 'local.rebar'].includes(subcommand)) return { permission: 'network', riskLevel: 2, ruleId: `known.elixir.mix.${subcommand}`, reason: '下载 Elixir 依赖或工具' }
    return { permission: 'shell', riskLevel: 1, ruleId: 'known.elixir.mix', reason: '构建或测试 Elixir 工作区' }
  }
  if (executable === 'nuget') {
    if (['push', 'delete'].includes(subcommand)) return { permission: 'external_effect', riskLevel: 2, ruleId: `known.dotnet.nuget.${subcommand}`, reason: '修改远端 NuGet 包状态' }
    if (['install', 'restore', 'update'].includes(subcommand)) return { permission: 'network', riskLevel: 2, ruleId: `known.dotnet.nuget.${subcommand}`, reason: '下载或更新 NuGet 依赖' }
    return { permission: 'shell', riskLevel: 1, ruleId: 'known.dotnet.nuget', reason: '运行 NuGet 命令' }
  }
  if (BUILD_COMMANDS.has(executable)) return { permission: 'shell', riskLevel: 1, ruleId: `known.build.${executable}`, reason: '构建或测试工作区' }
  if (['curl', 'wget', 'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm'].includes(executable)) return { permission: 'network', riskLevel: 2, ruleId: `known.network.${executable}`, reason: '访问外部网络' }
  if (['rm', 'rmdir', 'del', 'erase', 'remove-item', 'ri'].includes(executable)) return { permission: 'delete', riskLevel: 3, ruleId: `known.delete.${executable}`, reason: '删除文件或目录' }
  if (['docker', 'kubectl', 'helm'].includes(executable)) return { permission: 'external_effect', riskLevel: 2, ruleId: `known.platform.${executable}`, reason: '影响外部运行环境' }
  if (['terraform', 'tofu', 'ansible', 'ansible-playbook'].includes(executable)) return { permission: 'external_effect', riskLevel: 2, ruleId: `known.infrastructure.${executable}`, reason: '读取或修改外部基础设施' }
  if (['gh', 'glab', 'aws', 'az', 'gcloud'].includes(executable)) return { permission: 'external_effect', riskLevel: 2, ruleId: `known.remote.${executable}`, reason: '访问或修改远端平台状态' }
  if (['adb', 'fastboot'].includes(executable)) return { permission: 'external_effect', riskLevel: 2, ruleId: `known.device.${executable}`, reason: '访问或修改外部设备状态' }
  if (DATABASE_CLIENTS.has(executable)) return { permission: 'external_effect', riskLevel: 2, ruleId: `known.database.${executable}`, reason: '访问或修改数据库状态' }
  return null
}
