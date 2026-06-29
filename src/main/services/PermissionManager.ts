import * as path from 'path'

export type CommandRisk = 'safe' | 'write' | 'network' | 'destructive' | 'unknown'
export type PermissionResult = 'allow' | 'ask' | 'deny'

export interface PermissionRequest {
  id: string
  toolName: string
  risk: CommandRisk
  description: string
  args: any
}

export class PermissionManager {
  private static instance: PermissionManager

  private constructor() {}

  public static getInstance(): PermissionManager {
    if (!PermissionManager.instance) {
      PermissionManager.instance = new PermissionManager()
    }
    return PermissionManager.instance
  }

  private getCommandFromArgs(parsedArgs: any): string {
    return parsedArgs?.commandLine || parsedArgs?.CommandLine || parsedArgs?.command || ''
  }

  public getCommandRisk(command: string): CommandRisk {
    const safeCmds = ['npm test', 'npm run test', 'npm run typecheck', 'npm run build', 'git status', 'git diff', 'git log']
    const writeCmds = ['npm install', 'npm i', 'npm run package', 'yarn install', 'yarn add', 'pnpm install', 'pnpm add']
    const networkCmds = ['curl', 'wget']
    const destructiveCmds = ['rm', 'del', 'git reset --hard', 'git clean', 'rmdir', 'rd']

    const lowerCmd = command.toLowerCase().trim()
    
    if (safeCmds.some(c => lowerCmd === c || lowerCmd.startsWith(`${c} `))) return 'safe'
    if (destructiveCmds.some(c => lowerCmd === c || lowerCmd.startsWith(`${c} `))) return 'destructive'
    if (writeCmds.some(c => lowerCmd === c || lowerCmd.startsWith(`${c} `))) return 'write'
    if (networkCmds.some(c => lowerCmd === c || lowerCmd.startsWith(`${c} `))) return 'network'
    
    return 'unknown'
  }

  public checkToolPermission(toolName: string, parsedArgs: any, workspaceRoot: string): PermissionResult {
    if (['search', 'list_files', 'read_files', 'get_project_snapshot', 'fast_context'].includes(toolName)) {
      return 'allow'
    }

    if (toolName === 'rollback_last_edit') {
      return 'ask'
    }

    // 2. 写入类工具：安全边界内拦截，符合边界则直接允许，超出边界直接拒绝
    if (['apply_patch', 'write_to_file', 'replace_file_content', 'multi_replace_file_content'].includes(toolName)) {
      // workspace check
      let targetPath = parsedArgs?.filePath || parsedArgs?.TargetFile || parsedArgs?.file_path || parsedArgs?.path
      if (targetPath) {
        if (!path.isAbsolute(targetPath)) {
          targetPath = path.resolve(workspaceRoot, targetPath)
        }
        // Convert backward slashes to forward for uniform comparison if needed, or just case insensitive startswith
        const normalizedTarget = targetPath.replace(/\\/g, '/').toLowerCase()
        const normalizedRoot = workspaceRoot.replace(/\\/g, '/').toLowerCase()
        if (!normalizedTarget.startsWith(normalizedRoot)) {
          return 'deny'
        }
      }
      return 'allow'
    }

    if (toolName === 'run_command') {
      const risk = this.getCommandRisk(this.getCommandFromArgs(parsedArgs))
      if (risk === 'safe') return 'allow'
      if (risk === 'destructive') return 'ask'
      return 'ask'
    }

    return 'ask'
  }

  public createPermissionRequest(toolName: string, parsedArgs: any): PermissionRequest {
    let risk: CommandRisk = 'unknown'
    let description = `Requesting permission to run tool ${toolName}`

    if (toolName === 'run_command') {
      const cmd = this.getCommandFromArgs(parsedArgs)
      risk = this.getCommandRisk(cmd)
      description = `Execute command: ${cmd}`
    } else if (['write_to_file', 'replace_file_content', 'apply_patch'].includes(toolName)) {
      const targetPath = parsedArgs?.TargetFile || parsedArgs?.filePath || parsedArgs?.file_path || parsedArgs?.path || 'unknown path'
      risk = 'write'
      description = `Modify file: ${targetPath}`
    }

    return {
      id: `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      toolName,
      risk,
      description,
      args: parsedArgs
    }
  }
}
