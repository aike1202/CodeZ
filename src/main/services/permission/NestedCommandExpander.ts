import { createHash } from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import type { PermissionSnapshot } from '../../../shared/types/permission'
import type { PermissionShellKind } from './operationTypes'
import { normalizeExecutableName } from './executableName'

const PACKAGE_MANAGER_VERSION_FLAGS = new Set(['-v', '--version', '-version'])
const PACKAGE_MANAGER_BUILTINS = new Set([
  'install', 'add', 'update', 'ci', 'remove', 'uninstall', 'audit', 'publish', 'unpublish',
  'login', 'logout', 'deprecate', 'dist-tag', 'access', 'owner', 'token', 'version',
  'exec', 'x', 'dlx', 'create', 'init', 'config', 'cache', 'list', 'ls', 'view', 'info',
  'search', 'outdated', 'doctor', 'root', 'bin', 'prefix', 'whoami', 'help', 'set'
])

export interface ExpandedCommand {
  command: string | null
  shell: PermissionShellKind | null
  snapshots: PermissionSnapshot[]
  opaqueReason?: string
  kind?: 'wrapper' | 'script'
  cwd?: string
}

async function snapshot(filePath: string, content?: string | Buffer): Promise<PermissionSnapshot> {
  const bytes = content ?? await fs.readFile(filePath)
  return { path: filePath, sha256: createHash('sha256').update(bytes).digest('hex') }
}

export class NestedCommandExpander {
  async expandCommand(
    parentShell: PermissionShellKind,
    argv: string[],
    workspaceRoot: string,
    cwd: string,
    depth = 0,
    seen = new Set<string>()
  ): Promise<ExpandedCommand> {
    if (depth > 4) return { command: null, shell: null, snapshots: [], opaqueReason: 'nested-depth' }
    const rawExecutable = argv[0] || ''
    const executable = normalizeExecutableName(rawExecutable)
    const candidate = rawExecutable && (path.isAbsolute(rawExecutable) ? rawExecutable : path.resolve(cwd, rawExecutable))
    const extension = candidate ? path.extname(candidate).toLowerCase() : ''
    const baseName = candidate ? path.basename(candidate).toLowerCase() : ''
    const localShell = extension === '.ps1'
      ? 'powershell'
      : extension === '.cmd' || extension === '.bat'
        ? 'cmd'
        : extension === '.sh' || ['mvnw', 'gradlew'].includes(baseName)
          ? 'bash'
          : null
    const explicitPath = path.isAbsolute(rawExecutable) || /[\\/]/.test(rawExecutable)
    if (candidate && localShell && (explicitPath || ['npm', 'pnpm', 'yarn', 'bun'].includes(executable))) {
      if (seen.has(candidate)) return { command: null, shell: null, snapshots: [], opaqueReason: 'nested-cycle' }
      try {
        const command = await fs.readFile(candidate, 'utf8')
        seen.add(candidate)
        return { command, shell: localShell, snapshots: [await snapshot(candidate, command)], kind: 'script', cwd }
      } catch {
        if (explicitPath) return { command: null, shell: null, snapshots: [], opaqueReason: 'unreadable-script' }
      }
    }
    if (['bash', 'sh', 'zsh'].includes(executable)) {
      const index = argv.findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(arg))
      return index >= 0 && argv[index + 1]
        ? { command: argv[index + 1], shell: 'bash', snapshots: [], kind: 'wrapper', cwd }
        : { command: null, shell: null, snapshots: [], opaqueReason: 'dynamic-shell' }
    }
    if (['powershell', 'pwsh'].includes(executable)) {
      if (argv.some((arg) => /^-(?:encodedcommand|enc|e)$/i.test(arg))) {
        return { command: null, shell: null, snapshots: [], opaqueReason: 'encoded-command' }
      }
      const index = argv.findIndex((arg) => /^-(?:command|c)$/i.test(arg))
      return index >= 0 && argv[index + 1]
        ? { command: argv.slice(index + 1).join(' '), shell: 'powershell', snapshots: [], kind: 'wrapper', cwd }
        : { command: null, shell: null, snapshots: [], opaqueReason: 'dynamic-powershell' }
    }
    if (executable === 'cmd') {
      const index = argv.findIndex((arg) => /^\/(?:c|k)$/i.test(arg))
      return index >= 0 && argv[index + 1]
        ? { command: argv.slice(index + 1).join(' '), shell: 'cmd', snapshots: [], kind: 'wrapper', cwd }
        : { command: null, shell: null, snapshots: [], opaqueReason: 'dynamic-cmd' }
    }
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) {
      let commandIndex = 1
      let packageRoot = cwd
      const directoryOption = argv[1]
      const acceptsDirectoryOption =
        (executable === 'npm' && directoryOption === '--prefix') ||
        (executable === 'pnpm' && ['-C', '--dir'].includes(directoryOption)) ||
        (['yarn', 'bun'].includes(executable) && directoryOption === '--cwd')
      if (acceptsDirectoryOption) {
        if (!argv[2]) return { command: null, shell: null, snapshots: [], opaqueReason: 'missing-package-root' }
        packageRoot = path.resolve(cwd, argv[2])
        commandIndex = 3
      }
      const rawSubcommand = argv[commandIndex] || ''
      const subcommand = rawSubcommand.toLowerCase()
      if (PACKAGE_MANAGER_BUILTINS.has(subcommand)) {
        return { command: null, shell: null, snapshots: [] }
      }
      if (commandIndex === 1 && argv.length === 2 && PACKAGE_MANAGER_VERSION_FLAGS.has(rawSubcommand)) {
        return { command: null, shell: null, snapshots: [] }
      }
      const scriptName = rawSubcommand === 'run' ? argv[commandIndex + 1] : rawSubcommand
      if (!scriptName) return { command: null, shell: null, snapshots: [], opaqueReason: 'missing-script' }
      const packagePath = path.join(packageRoot, 'package.json')
      try {
        const content = await fs.readFile(packagePath, 'utf8')
        const command = JSON.parse(content)?.scripts?.[scriptName]
        if (typeof command !== 'string') return { command: null, shell: null, snapshots: [], opaqueReason: 'unknown-script' }
        return { command, shell: parentShell, snapshots: [await snapshot(packagePath, content)], kind: 'script', cwd: packageRoot }
      } catch {
        return { command: null, shell: null, snapshots: [], opaqueReason: 'unreadable-package-script' }
      }
    }
    if (candidate && localShell && seen.has(candidate)) {
      return { command: null, shell: null, snapshots: [], opaqueReason: 'nested-cycle' }
    }
    if (candidate && localShell) {
      try {
        seen.add(candidate)
        const command = await fs.readFile(candidate, 'utf8')
        return { command, shell: localShell, snapshots: [await snapshot(candidate, command)], kind: 'script', cwd }
      } catch {
        return { command: null, shell: null, snapshots: [], opaqueReason: 'unreadable-script' }
      }
    }
    return { command: null, shell: null, snapshots: [] }
  }
}
