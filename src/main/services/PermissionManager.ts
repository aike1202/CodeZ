import { PermissionRuleStore } from './PermissionRuleStore'
import { CommandAnalyzer, CommandRisk } from './CommandAnalyzer'
import * as path from 'path'

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
    return CommandAnalyzer.analyze(command)
  }

  public checkToolPermission(toolName: string, parsedArgs: any, workspaceRoot: string, workspaceMode: 'ask' | 'auto-approve-safe' | 'full-access' = 'auto-approve-safe'): PermissionResult {
    // 0. Base safe tools
    if (['list_files', 'update_resume_state', 'UpdatePlanStep', 'ExitPlanMode', 'Read', 'NotebookEdit', 'Glob', 'Grep', 'Skill', 'PushNotification', 'AskUserQuestion', 'view_file', 'grep_search'].includes(toolName)) {
      return 'allow'
    }

    if (toolName === 'rollback_last_edit') {
      return 'ask'
    }

    // 1. Terminal Commands
    if (toolName === 'Bash' || toolName === 'PowerShell' || toolName === 'run_command') {
      const command = this.getCommandFromArgs(parsedArgs)
      const risk = this.getCommandRisk(command)

      // User request: full-access should also ask for dangerous commands
      if (workspaceMode === 'full-access' && risk !== 'destructive') {
        return 'allow'
      }

      // Check Whitelist first
      if (PermissionRuleStore.getInstance().isCommandWhitelisted(command)) {
        return 'allow'
      }

      if (risk === 'destructive') return 'ask' // always ask for destructive
      if (risk === 'safe') return 'allow' // safe commands are allowed in all modes

      if (workspaceMode === 'ask') return 'ask'

      // auto-approve-safe logic for terminal
      if (risk === 'write') return 'allow'
      if (risk === 'network') return 'ask'

      return 'ask'
    }

    // 2. File Write/Edit Tools
    if (['Edit', 'Write', 'write_to_file', 'replace_file_content', 'multi_replace_file_content'].includes(toolName)) {
      let targetPath = parsedArgs?.filePath || parsedArgs?.TargetFile || parsedArgs?.file_path || parsedArgs?.path
      if (targetPath) {
        if (!path.isAbsolute(targetPath)) {
          targetPath = path.resolve(workspaceRoot, targetPath)
        }
        
        if (PermissionRuleStore.getInstance().isPathWhitelisted(targetPath)) {
          return 'allow'
        }

        // Secure boundary check
        const relativePath = path.relative(workspaceRoot, targetPath)
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
          return 'deny' // Escape attempt
        }
      }

      if (workspaceMode === 'full-access') {
        return 'allow'
      }

      return workspaceMode === 'ask' ? 'ask' : 'allow'
    }

    if (workspaceMode === 'full-access') {
      return 'allow'
    }

    return 'ask'
  }

  public createPermissionRequest(toolName: string, parsedArgs: any): PermissionRequest {
    let risk: CommandRisk = 'unknown'
    let description = `Requesting permission to run tool ${toolName}`

    if (toolName === 'Bash' || toolName === 'PowerShell' || toolName === 'run_command') {
      const cmd = this.getCommandFromArgs(parsedArgs)
      risk = this.getCommandRisk(cmd)
      description = `Execute command: ${cmd}`
    } else if (['Edit', 'Write', 'write_to_file', 'replace_file_content', 'multi_replace_file_content'].includes(toolName)) {
      const targetPath = parsedArgs?.file_path || parsedArgs?.filePath || parsedArgs?.TargetFile || parsedArgs?.path || 'unknown path'
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
