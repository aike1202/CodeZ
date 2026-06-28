import { IPC_CHANNELS } from '../../shared/ipc/channels'
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

  public getCommandRisk(command: string): CommandRisk {
    const safeCmds = ['npm test', 'npm run typecheck', 'git status', 'git diff', 'git log']
    const writeCmds = ['npm install', 'npm run package', 'npm i', 'yarn install']
    const networkCmds = ['curl', 'wget']
    const destructiveCmds = ['rm', 'del', 'git reset --hard', 'git clean', 'rmdir', 'rd']

    const lowerCmd = command.toLowerCase().trim()
    
    if (safeCmds.some(c => lowerCmd.startsWith(c))) return 'safe'
    if (writeCmds.some(c => lowerCmd.startsWith(c))) return 'write'
    if (networkCmds.some(c => lowerCmd.startsWith(c))) return 'network'
    if (destructiveCmds.some(c => lowerCmd.startsWith(c))) return 'destructive'
    
    return 'unknown'
  }

  public checkToolPermission(toolName: string, parsedArgs: any, workspaceRoot: string): PermissionResult {
    if (['search', 'list_files', 'read_files', 'get_project_snapshot', 'fast_context', 'rollback_last_edit'].includes(toolName)) {
      return 'allow'
    }

    // 2. 写入类工具：安全边界内拦截询问，超出边界直接拒绝
    if (['apply_patch'].includes(toolName)) {
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
      return 'ask'
    }

    if (toolName === 'run_command') {
      const risk = this.getCommandRisk(parsedArgs?.CommandLine || parsedArgs?.command || '')
      if (risk === 'safe') return 'allow'
      return 'ask'
    }

    return 'ask'
  }

  public createPermissionRequest(toolName: string, parsedArgs: any): PermissionRequest {
    let risk: CommandRisk = 'unknown'
    let description = `Requesting permission to run tool ${toolName}`

    if (toolName === 'run_command') {
      const cmd = parsedArgs?.CommandLine || parsedArgs?.command || ''
      risk = this.getCommandRisk(cmd)
      description = `Execute command: ${cmd}`
    } else if (['write_to_file', 'replace_file_content', 'apply_patch'].includes(toolName)) {
      const targetPath = parsedArgs?.TargetFile || parsedArgs?.file_path || parsedArgs?.path || 'unknown path'
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
