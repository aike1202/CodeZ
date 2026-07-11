// src/main/tools/builtin/BashTool.ts
import { Tool, ToolContext } from '../Tool'
import * as path from 'path'
import * as fs from 'fs'
import { execSync } from 'child_process'
import { SpawnRunner } from '../SpawnRunner'

interface BashArgs {
  command?: string
  description?: string
  timeout?: number
  run_in_background?: boolean
  dangerouslyDisableSandbox?: boolean
}

const DEFAULT_TIMEOUT = 120000
const MAX_TIMEOUT = 600000

const sessionCwd: Map<string, string> = new Map()

export function resolveBashExe(): string {
  if (process.env.CODEZ_BASH_PATH && fs.existsSync(process.env.CODEZ_BASH_PATH)) return process.env.CODEZ_BASH_PATH
  if (process.env.GIT_BASH_PATH && fs.existsSync(process.env.GIT_BASH_PATH)) return process.env.GIT_BASH_PATH
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  try {
    const which = execSync('where bash', { encoding: 'utf-8' }).split('\n').map((s) => s.trim()).filter(Boolean)
    if (which.length > 0 && fs.existsSync(which[0])) return which[0]
  } catch {}
  return 'bash'
}

/** 检测命令首部 `cd <dir>`，返回解析后的绝对路径（相对当前 cwd），无则 null。 */
function detectCd(command: string, currentCwd: string): string | null {
  const m = command.match(/^\s*cd\s+([^\s&|;]+)/)
  if (!m) return null
  const target = m[1].replace(/^["']|["']$/g, '')
  if (!target) return null
  const resolved = path.isAbsolute(target) ? target : path.resolve(currentCwd, target)
  if (fs.existsSync(resolved)) return resolved
  return null
}

export class BashTool extends Tool {
  get name() {
    return 'Bash'
  }

  get summary() {
    return 'Execute a bash command in the workspace.'
  }

  get description() {
    return 'Executes a bash command and returns its output. Runs Git Bash (POSIX sh), not cmd.exe or PowerShell — use Unix shell syntax (/dev/null not NUL, forward slashes, $VAR not %VAR%); for multi-line strings use a heredoc. Working directory persists between calls, but prefer absolute paths — `cd` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist; the shell is initialized from the user\'s profile. Avoid using this for find/grep/cat/head/tail/sed/awk/echo — use dedicated tools (Glob/Grep/Read). timeout in ms (default 120000, max 600000). run_in_background runs detached and keeps running across turns. Interactive flags (e.g. git rebase -i) are not supported; commit/push only when asked. To stop a background process, run `kill <pid>` in a later Bash call.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute.' },
        description: { type: 'string', description: 'Short description of what the command does.' },
        timeout: { type: 'number', description: 'Timeout in ms. Default 120000, max 600000.' },
        run_in_background: { type: 'boolean', description: 'Run detached; returns pid + stdoutFile immediately.' },
        dangerouslyDisableSandbox: { type: 'boolean', description: 'Reserved (no sandbox this period).' }
      },
      required: ['command']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as BashArgs
      if (!parsed.command) return 'Error: command is required.'

      const sessionId = context.sessionId || '_default'
      const currentCwd = sessionCwd.get(sessionId) || context.workspaceRoot
      const executable = resolveBashExe()

      let timeout = parsed.timeout ?? DEFAULT_TIMEOUT
      if (timeout > MAX_TIMEOUT) timeout = MAX_TIMEOUT

      const runner = new SpawnRunner()
      const result = await runner.run({
        command: parsed.command,
        cwd: currentCwd,
        shell: 'bash',
        executable,
        timeout,
        run_in_background: parsed.run_in_background === true,
        abortSignal: context.abortSignal
      })

      // 持久化 cd 后的工作目录（前台命令才检测；后台不切换主会话 cwd）
      if (!result.background) {
        const next = detectCd(parsed.command, currentCwd)
        if (next) sessionCwd.set(sessionId, next)
      }

      return JSON.stringify({
        command: parsed.command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        background: result.background,
        pid: result.pid,
        stdoutFile: result.stdoutFile,
        truncated: result.truncated
      }, null, 2)
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }
}
