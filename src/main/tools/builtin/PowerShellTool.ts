// src/main/tools/builtin/PowerShellTool.ts
import { Tool, ToolContext } from '../Tool'
import * as path from 'path'
import * as fs from 'fs'
import { SpawnRunner } from '../SpawnRunner'

interface PSArgs {
  command?: string
  description?: string
  timeout?: number
  run_in_background?: boolean
  dangerouslyDisableSandbox?: boolean
}

const DEFAULT_TIMEOUT = 120000
const MAX_TIMEOUT = 600000

const sessionCwd: Map<string, string> = new Map()

export function resolvePwshExe(): string {
  if (process.env.CODEZ_PS_PATH && fs.existsSync(process.env.CODEZ_PS_PATH)) return process.env.CODEZ_PS_PATH
  return 'powershell.exe'
}

function detectCd(command: string, currentCwd: string): string | null {
  const m = command.match(/^\s*(?:cd|Set-Location)\s+([^\s;&|]+)/)
  if (!m) return null
  const target = m[1].replace(/^["']|["']$/g, '')
  if (!target) return null
  const resolved = path.isAbsolute(target) ? target : path.resolve(currentCwd, target)
  if (fs.existsSync(resolved)) return resolved
  return null
}

export class PowerShellTool extends Tool {
  get name() {
    return 'PowerShell'
  }

  get description() {
    return `Executes a PowerShell command with optional timeout. Working directory persists between calls; shell state does not. Edition: Windows PowerShell 5.1 (powershell.exe). Pipeline chain && and || are NOT available — use "A; if ($?) { B }". Ternary ?:, null-coalescing ??, and null-conditional ?. are NOT available. Avoid 2>&1 on native exes (wraps stderr in ErrorRecord). Default file encoding is UTF-16 LE; pass -Encoding utf8 to Out-File/Set-Content. ConvertFrom-Json returns PSCustomObject, not a hashtable (-AsHashtable unavailable). Use Glob/Grep/Read/Edit/Write instead of Get-ChildItem -Recurse / Select-String / Get-Content / Set-Content. Interactive/blocking commands (Read-Host, Get-Credential, Out-GridView, git rebase -i) are forbidden (runs with -NonInteractive); add -Confirm:$false to destructive cmdlets you intend to run. timeout in ms (default 120000, max 600000); run_in_background runs detached. To stop a background process, run Stop-Process -Id <pid> in a later PowerShell call. Do not prefix commands with cd — the working directory is already set. Avoid Start-Sleep: run long commands with run_in_background and you will be notified on completion. Unix equivalents: head/tail -> Get-Content -TotalCount/-Tail; which -> (Get-Command name).Source; touch -> if (-not (Test-Path p)) { New-Item -ItemType File p } (never New-Item -Force on a file); wc -l -> (Get-Content p | Measure-Object -Line).Lines; mkdir -p -> New-Item -ItemType Directory -Force p; rm -rf -> Remove-Item -Recurse -Force p. Multiline strings to native exes: use a single-quoted here-string @'...'@ with the closing '@ at column 0. For git: prefer a new commit over amending; never use --no-verify/--no-gpg-sign unless the user asks; avoid destructive ops (reset --hard, push --force) unless truly the best approach.`
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The PowerShell command to execute.' },
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
      const parsed = JSON.parse(args) as PSArgs
      if (!parsed.command) return 'Error: command is required.'

      const sessionId = context.sessionId || '_default'
      const currentCwd = sessionCwd.get(sessionId) || context.workspaceRoot
      const executable = resolvePwshExe()

      let timeout = parsed.timeout ?? DEFAULT_TIMEOUT
      if (timeout > MAX_TIMEOUT) timeout = MAX_TIMEOUT

      const runner = new SpawnRunner()
      const result = await runner.run({
        command: parsed.command,
        cwd: currentCwd,
        shell: 'powershell',
        executable,
        timeout,
        run_in_background: parsed.run_in_background === true
      })

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
