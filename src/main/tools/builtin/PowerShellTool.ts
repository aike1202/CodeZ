// src/main/tools/builtin/PowerShellTool.ts
import * as fs from 'fs'
import * as path from 'path'
import { Tool, ToolContext } from '../Tool'
import { getCommandTaskRegistry, SpawnRunner, type SpawnResult } from '../SpawnRunner'

interface PowerShellArgs {
  command?: string
  description?: string
  timeout?: number
  task_id?: string
  action?: 'wait' | 'interrupt'
  run_in_background?: boolean
  dangerouslyDisableSandbox?: boolean
}

const DEFAULT_TIMEOUT = 30_000
const MIN_TIMEOUT = 250
const MAX_TIMEOUT = 120_000

const sessionCwd: Map<string, string> = new Map()

function resolveTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT
  return Math.min(Math.max(Math.round(value!), MIN_TIMEOUT), MAX_TIMEOUT)
}

function formatResult(result: SpawnResult): string {
  const payload: Record<string, unknown> = { ...result }
  if (result.status === 'running') {
    payload.message = 'Command is still running. Choose wait with a new timeout or interrupt it.'
    payload.nextActions = [
      { action: 'wait', task_id: result.taskId },
      { action: 'interrupt', task_id: result.taskId }
    ]
  } else if (result.status === 'interrupted') {
    payload.error = {
      code: 'COMMAND_INTERRUPTED',
      message: 'The command was interrupted before completion.'
    }
  }
  return JSON.stringify(payload, null, 2)
}

export function resolvePwshExe(): string {
  if (process.env.CODEZ_PS_PATH && fs.existsSync(process.env.CODEZ_PS_PATH)) return process.env.CODEZ_PS_PATH
  return 'powershell.exe'
}

function detectCd(command: string, currentCwd: string): string | null {
  const match = command.match(/^\s*(?:cd|Set-Location)\s+([^\s;&|]+)/)
  if (!match) return null
  const target = match[1].replace(/^["']|["']$/g, '')
  if (!target) return null
  const resolved = path.isAbsolute(target) ? target : path.resolve(currentCwd, target)
  return fs.existsSync(resolved) ? resolved : null
}

export class PowerShellTool extends Tool {
  get name() { return 'PowerShell' }

  get summary() { return 'Execute or control a PowerShell command.' }

  get description() {
    return `Executes or controls a PowerShell command. For a new command, set command and choose timeout based on the expected time. timeout is only the current wait window in ms (default 30000, min 250, max 120000): if it expires, the process keeps running and the result returns status=running plus taskId. Then call PowerShell with task_id and action=wait (optionally a new timeout) or action=interrupt. Do not rerun the original command. Working directory persists between calls; shell state does not. Edition: Windows PowerShell 5.1 (powershell.exe). Pipeline chain && and || are unavailable; use "A; if ($?) { B }". Use explicit UTF-8 for file operations and dedicated Glob/Grep/Read/Edit/Write tools for repository work. Interactive commands are forbidden. run_in_background remains available for intentionally detached processes. Do not prefix commands with cd because the working directory is already set.`
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'New PowerShell command to execute. Omit when controlling task_id.' },
        description: { type: 'string', description: 'Short description of what the command does.' },
        timeout: { type: 'number', description: 'Current wait window in ms. Default 30000, min 250, max 120000. Expiry does not kill the command.' },
        task_id: { type: 'string', description: 'Task id returned when a previous command is still running.' },
        action: { type: 'string', enum: ['wait', 'interrupt'], description: 'With task_id: wait again or interrupt the running command.' },
        run_in_background: { type: 'boolean', description: 'Run intentionally detached; returns pid + stdoutFile immediately.' },
        dangerouslyDisableSandbox: { type: 'boolean', description: 'Reserved (no sandbox this period).' }
      },
      additionalProperties: false
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as PowerShellArgs
      const sessionId = context.sessionId || '_default'
      const currentCwd = sessionCwd.get(sessionId) || context.workspaceRoot
      const runner = new SpawnRunner()

      if (parsed.task_id) {
        if (parsed.command) return 'Error: command and task_id cannot be used together.'
        if (!parsed.action) return 'Error: action is required with task_id.'
        const registry = getCommandTaskRegistry()
        const task = registry.get(parsed.task_id)
        if (!task) return `Error: Command task '${parsed.task_id}' was not found.`
        if (task.sessionId !== sessionId) return 'Access denied. This command task belongs to another session.'
        if (task.shellType !== 'powershell') return 'Error: This command task was not started by PowerShell.'
        registry.bindToolCall(parsed.task_id, context.toolCallId)
        const result = parsed.action === 'interrupt'
          ? runner.interrupt(parsed.task_id)
          : await runner.wait(parsed.task_id, resolveTimeout(parsed.timeout))
        return result ? formatResult(result) : `Error: Command task '${parsed.task_id}' was not found.`
      }

      if (!parsed.command) return 'Error: command is required for a new command.'
      if (parsed.action) return 'Error: action requires task_id.'

      const result = await runner.run({
        command: parsed.command,
        cwd: currentCwd,
        shell: 'powershell',
        executable: resolvePwshExe(),
        timeout: resolveTimeout(parsed.timeout),
        run_in_background: parsed.run_in_background === true,
        abortSignal: context.abortSignal,
        sessionId,
        toolCallId: context.toolCallId
      })

      if (!result.background) {
        const next = detectCd(parsed.command, currentCwd)
        if (next) sessionCwd.set(sessionId, next)
      }

      return formatResult({ ...result, command: parsed.command })
    } catch (error: any) {
      return `Error: ${error.message}`
    }
  }
}
