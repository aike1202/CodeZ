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
    return 'Executes a terminal command (like npm test, build, or git commands) in a specified directory. Returns the standard output and error output.'
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
      const commandLine = parsedArgs.commandLine
      const cwdParam = parsedArgs.cwd || '.'
      let timeoutMs = parsedArgs.timeoutMs || 30000

      if (!commandLine) return 'Error: commandLine is required.'

      if (timeoutMs > 120000) {
        timeoutMs = 120000 // 硬性上限 2 分钟，防止 Agent 卡死
      }

      const cwd = path.resolve(context.workspaceRoot, cwdParam)

      // 防御限制
      if (!cwd.startsWith(context.workspaceRoot)) {
        return `Error: Access denied. Cannot execute commands outside of workspace.`
      }

      // 执行命令
      try {
        const { stdout, stderr } = await execAsync(commandLine, {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024 // 10MB buffer
        })

        return this.formatResult(stdout, stderr, 0)
      } catch (err: any) {
        // 如果命令退出码非 0，execAsync 会抛出异常，其中包含 stdout, stderr, code
        if (err.killed && err.signal === 'SIGTERM') {
          return `Error: Command timed out after ${timeoutMs}ms.\n\nPartial Stdout:\n${this.truncate(err.stdout)}\n\nPartial Stderr:\n${this.truncate(err.stderr)}`
        }

        return this.formatResult(err.stdout || '', err.stderr || err.message, err.code || 1)
      }

    } catch (err: any) {
      return `Error executing command: ${err.message}`
    }
  }

  private formatResult(stdout: string | Buffer, stderr: string | Buffer, code: number): string {
    const outStr = this.truncate(stdout.toString())
    const errStr = this.truncate(stderr.toString())

    let result = `Exit Code: ${code}\n`
    if (outStr) {
      result += `\nSTDOUT:\n${outStr}\n`
    }
    if (errStr) {
      result += `\nSTDERR:\n${errStr}\n`
    }
    return result.trim()
  }

  private truncate(text: string): string {
    if (!text) return ''
    const maxLen = 4000
    if (text.length <= maxLen) return text
    
    // 如果太长，保留头尾，砍掉中间
    const headChars = 1000
    const tailChars = 3000
    
    return `${text.slice(0, headChars)}\n\n[... Output Truncated. Original size: ${text.length} chars ...]\n\n${text.slice(-tailChars)}`
  }
}
