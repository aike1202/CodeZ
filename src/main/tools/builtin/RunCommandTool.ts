import { Tool, ToolContext } from '../Tool'
import * as child_process from 'child_process'
import * as path from 'path'
import * as util from 'util'

const execAsync = util.promisify(child_process.exec)

export class RunCommandTool extends Tool {
  get name() {
    return 'run_command'
  }

  get description() {
    return 'Executes a terminal command (like npm test, build, or git commands) in a specified directory. Returns structured JSON with command, exitCode, stdout, stderr, timedOut, and truncated.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        commandLine: {
          type: 'string',
          description: 'The exact command to execute (e.g., "npm run typecheck").'
        },
        cwd: {
          type: 'string',
          description: 'The directory to run the command in, relative to the workspace root. Use "." for the root itself.'
        },
        timeoutMs: {
          type: 'number',
          description: 'Optional timeout in milliseconds. Defaults to 30000 (30 seconds). Max 120000.'
        }
      },
      required: ['commandLine', 'cwd']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      if (!args) return 'Error: Missing arguments.'
      const parsedArgs = JSON.parse(args)
      const commandLine = parsedArgs.commandLine || parsedArgs.CommandLine || parsedArgs.command
      const cwdParam = parsedArgs.cwd || '.'
      let timeoutMs = parsedArgs.timeoutMs || 30000

      if (!commandLine) return 'Error: commandLine is required.'

      if (timeoutMs > 120000) {
        timeoutMs = 120000 // 硬性上限 2 分钟，防止 Agent 卡死
      }

      const cwd = path.resolve(context.workspaceRoot, cwdParam)

      // 防御限制
      const normalizedCwd = cwd.replace(/\\/g, '/').toLowerCase()
      const normalizedRoot = context.workspaceRoot.replace(/\\/g, '/').toLowerCase()
      if (!normalizedCwd.startsWith(normalizedRoot)) {
        return `Error: Access denied. Cannot execute commands outside of workspace.`
      }

      // 执行命令
      try {
        const { stdout, stderr } = await execAsync(commandLine, {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024 // 10MB buffer
        })

        return this.formatResult(commandLine, cwdParam, stdout, stderr, 0, false)
      } catch (err: any) {
        // 如果命令退出码非 0，execAsync 会抛出异常，其中包含 stdout, stderr, code
        const timedOut = Boolean(err.killed && err.signal === 'SIGTERM')
        return this.formatResult(
          commandLine,
          cwdParam,
          err.stdout || '',
          err.stderr || err.message,
          timedOut ? null : (err.code || 1),
          timedOut,
          timedOut ? `Command timed out after ${timeoutMs}ms.` : undefined
        )
      }

    } catch (err: any) {
      return `Error executing command: ${err.message}`
    }
  }

  private formatResult(
    command: string,
    cwd: string,
    stdout: string | Buffer,
    stderr: string | Buffer,
    exitCode: number | null,
    timedOut: boolean,
    error?: string
  ): string {
    const out = this.truncate(stdout.toString())
    const err = this.truncate(stderr.toString())

    return JSON.stringify({
      command,
      cwd,
      exitCode,
      stdout: out.text,
      stderr: err.text,
      timedOut,
      truncated: out.truncated || err.truncated,
      error
    }, null, 2)
  }

  private truncate(text: string): { text: string; truncated: boolean } {
    if (!text) return { text: '', truncated: false }
    const maxLen = 4000
    if (text.length <= maxLen) return { text, truncated: false }
    
    // 如果太长，保留头尾，砍掉中间
    const headChars = 1000
    const tailChars = 3000
    
    return {
      text: `${text.slice(0, headChars)}\n\n[... Output Truncated. Original size: ${text.length} chars ...]\n\n${text.slice(-tailChars)}`,
      truncated: true
    }
  }
}
