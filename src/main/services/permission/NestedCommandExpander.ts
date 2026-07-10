import { createHash } from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import type { PermissionSnapshot } from '../../../shared/types/permission'
import type { PermissionShellKind } from './operationTypes'

export interface ExpandedCommand {
  command: string | null
  shell: PermissionShellKind | null
  snapshots: PermissionSnapshot[]
  opaqueReason?: string
}

async function snapshot(filePath: string): Promise<PermissionSnapshot> {
  const content = await fs.readFile(filePath)
  return { path: filePath, sha256: createHash('sha256').update(content).digest('hex') }
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
    const executable = (argv[0] || '').toLowerCase().replace(/\.exe$/, '')
    if (['bash', 'sh', 'zsh'].includes(executable)) {
      const index = argv.findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(arg))
      return index >= 0 && argv[index + 1]
        ? { command: argv[index + 1], shell: 'bash', snapshots: [] }
        : { command: null, shell: null, snapshots: [], opaqueReason: 'dynamic-shell' }
    }
    if (['powershell', 'pwsh'].includes(executable)) {
      if (argv.some((arg) => /^-(?:encodedcommand|enc|e)$/i.test(arg))) {
        return { command: null, shell: null, snapshots: [], opaqueReason: 'encoded-command' }
      }
      const index = argv.findIndex((arg) => /^-(?:command|c)$/i.test(arg))
      return index >= 0 && argv[index + 1]
        ? { command: argv[index + 1], shell: 'powershell', snapshots: [] }
        : { command: null, shell: null, snapshots: [], opaqueReason: 'dynamic-powershell' }
    }
    if (executable === 'cmd') {
      const index = argv.findIndex((arg) => /^\/(?:c|k)$/i.test(arg))
      return index >= 0 && argv[index + 1]
        ? { command: argv.slice(index + 1).join(' '), shell: 'cmd', snapshots: [] }
        : { command: null, shell: null, snapshots: [], opaqueReason: 'dynamic-cmd' }
    }
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) {
      if (['install', 'add', 'update', 'ci', 'remove', 'uninstall'].includes((argv[1] || '').toLowerCase())) {
        return { command: null, shell: null, snapshots: [] }
      }
      const scriptName = argv[1] === 'run' ? argv[2] : argv[1]
      if (!scriptName) return { command: null, shell: null, snapshots: [], opaqueReason: 'missing-script' }
      const packagePath = path.join(workspaceRoot, 'package.json')
      try {
        const content = await fs.readFile(packagePath, 'utf8')
        const command = JSON.parse(content)?.scripts?.[scriptName]
        if (typeof command !== 'string') return { command: null, shell: null, snapshots: [], opaqueReason: 'unknown-script' }
        return { command, shell: parentShell, snapshots: [await snapshot(packagePath)] }
      } catch {
        return { command: null, shell: null, snapshots: [], opaqueReason: 'unreadable-package-script' }
      }
    }
    const candidate = argv[0] && (path.isAbsolute(argv[0]) ? argv[0] : path.resolve(cwd, argv[0]))
    const extension = candidate ? path.extname(candidate).toLowerCase() : ''
    const shell = extension === '.ps1' ? 'powershell' : extension === '.cmd' || extension === '.bat' ? 'cmd' : extension === '.sh' ? 'bash' : null
    if (candidate && shell && !seen.has(candidate)) {
      try {
        seen.add(candidate)
        return { command: await fs.readFile(candidate, 'utf8'), shell, snapshots: [await snapshot(candidate)] }
      } catch {
        return { command: null, shell: null, snapshots: [], opaqueReason: 'unreadable-script' }
      }
    }
    return { command: null, shell: null, snapshots: [] }
  }
}
