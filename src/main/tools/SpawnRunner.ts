// src/main/tools/SpawnRunner.ts
import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface SpawnResult {
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  command?: string
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  waitTimedOut: boolean
  background: boolean
  taskId?: string
  pid?: number
  stdoutFile?: string
  stderrFile?: string
  startedAt?: number
  elapsedMs?: number
  truncated: boolean
}

export interface RunOptions {
  command: string
  cwd: string
  shell: 'bash' | 'powershell'
  timeout?: number
  run_in_background?: boolean
  executable?: string
  env?: NodeJS.ProcessEnv
  abortSignal?: AbortSignal
  sessionId?: string
  toolCallId?: string
}

export interface BackgroundTaskEntry {
  pid: number
  stdoutFile: string
  stderrFile: string
  startedAt: number
  shellType: 'bash' | 'powershell'
}

export interface CommandTaskEntry {
  taskId: string
  pid?: number
  command: string
  sessionId?: string
  startedAt: number
  completedAt?: number
  shellType: 'bash' | 'powershell'
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  exitCode: number | null
}

interface ManagedCommandTask extends CommandTaskEntry {
  process: ChildProcess
  detached: boolean
  stdout: string
  stderr: string
  abortSignal?: AbortSignal
  abortProcess?: () => void
  interruptionRequested: boolean
  toolCallIds: Set<string>
  waiters: Set<() => void>
}

async function terminateProcess(proc: ChildProcess, detached = false): Promise<void> {
  if (typeof proc.pid !== 'number') return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      try {
        const killer = spawn('taskkill.exe', ['/pid', String(proc.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
        let settled = false
        const finish = (fallback: boolean) => {
          if (settled) return
          settled = true
          if (fallback) {
            try { proc.kill('SIGKILL') } catch {}
          }
          resolve()
        }
        killer.on('error', () => finish(true))
        killer.on('close', (code) => finish(code !== 0))
        killer.unref()
      } catch {
        try { proc.kill('SIGKILL') } catch {}
        resolve()
      }
    })
    return
  }
  try {
    process.kill(detached ? -proc.pid : proc.pid, 'SIGKILL')
  } catch {
    try { proc.kill('SIGKILL') } catch {}
  }
}

const LIVE_OUTPUT_LIMIT = 1_000_000
const LIVE_OUTPUT_HEAD = 200_000
const LIVE_OUTPUT_TAIL = 800_000

function appendLiveOutput(current: string, chunk: string): string {
  const combined = current + chunk
  if (combined.length <= LIVE_OUTPUT_LIMIT) return combined
  return [
    combined.slice(0, LIVE_OUTPUT_HEAD),
    '\n\n[System Note: Live command output capped while the process continues.]\n\n',
    combined.slice(-LIVE_OUTPUT_TAIL)
  ].join('')
}

export function truncateOutput(text: string, head = 1000, tail = 3000): { text: string; truncated: boolean } {
  if (!text) return { text: '', truncated: false }
  const maxLen = head + tail
  if (text.length <= maxLen) return { text, truncated: false }
  return {
    text: `${text.slice(0, head)}\n\n[System Note: Output truncated (Original size: ${text.length} chars). Head ${head} + tail ${tail} kept. Do NOT rerun the same command; redirect to a file and Read it, or filter with Grep.]\n\n${text.slice(-tail)}`,
    truncated: true
  }
}

export class BackgroundTaskRegistry {
  private tasks: Map<string, BackgroundTaskEntry> = new Map()
  private counter = 0

  add(entry: BackgroundTaskEntry): string {
    const id = `bg-${Date.now()}-${this.counter++}`
    this.tasks.set(id, entry)
    return id
  }
  get(taskId: string): BackgroundTaskEntry | undefined {
    return this.tasks.get(taskId)
  }
  list(): BackgroundTaskEntry[] {
    return Array.from(this.tasks.values())
  }
  remove(taskId: string): void {
    this.tasks.delete(taskId)
  }
}

let registryInstance: BackgroundTaskRegistry | null = null
export function getBackgroundTaskRegistry(): BackgroundTaskRegistry {
  if (!registryInstance) registryInstance = new BackgroundTaskRegistry()
  return registryInstance
}

export class CommandTaskRegistry {
  private readonly tasks = new Map<string, ManagedCommandTask>()
  private counter = 0

  add(proc: ChildProcess, opts: RunOptions, detached: boolean): string {
    this.prune()
    const taskId = `cmd-${Date.now()}-${this.counter++}`
    const task: ManagedCommandTask = {
      taskId,
      pid: proc.pid,
      command: opts.command,
      sessionId: opts.sessionId,
      startedAt: Date.now(),
      shellType: opts.shell,
      status: 'running',
      exitCode: null,
      process: proc,
      detached,
      stdout: '',
      stderr: '',
      abortSignal: opts.abortSignal,
      interruptionRequested: false,
      toolCallIds: new Set(opts.toolCallId ? [opts.toolCallId] : []),
      waiters: new Set()
    }
    this.tasks.set(taskId, task)

    proc.stdout?.on('data', (data) => {
      task.stdout = appendLiveOutput(task.stdout, data.toString())
    })
    proc.stderr?.on('data', (data) => {
      task.stderr = appendLiveOutput(task.stderr, data.toString())
    })

    const finish = (status: CommandTaskEntry['status'], exitCode: number | null) => {
      if (task.status !== 'running') return
      task.status = status
      task.exitCode = exitCode
      task.completedAt = Date.now()
      if (task.abortProcess) task.abortSignal?.removeEventListener('abort', task.abortProcess)
      for (const wake of task.waiters) wake()
      task.waiters.clear()
    }
    proc.on('error', (error) => {
      task.stderr = appendLiveOutput(task.stderr, `${task.stderr ? '\n' : ''}${error.message}`)
      finish('failed', 1)
    })
    proc.on('close', (code) => finish(
      task.interruptionRequested ? 'interrupted' : code === 0 ? 'completed' : 'failed',
      code
    ))

    task.abortProcess = () => { void this.interrupt(taskId) }
    opts.abortSignal?.addEventListener('abort', task.abortProcess, { once: true })
    if (opts.abortSignal?.aborted) task.abortProcess()
    return taskId
  }

  get(taskId: string): CommandTaskEntry | undefined {
    const task = this.tasks.get(taskId)
    if (!task) return undefined
    return this.publicEntry(task)
  }

  list(): CommandTaskEntry[] {
    return [...this.tasks.values()].map((task) => this.publicEntry(task))
  }

  bindToolCall(taskId: string, toolCallId?: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false
    if (toolCallId) task.toolCallIds.add(toolCallId)
    return true
  }

  interruptByToolCallId(toolCallId: string): Promise<SpawnResult | undefined> {
    for (const task of this.tasks.values()) {
      if (task.toolCallIds.has(toolCallId)) return this.interrupt(task.taskId)
    }
    return Promise.resolve(undefined)
  }

  async wait(taskId: string, timeoutMs: number): Promise<SpawnResult | undefined> {
    const task = this.tasks.get(taskId)
    if (!task) return undefined
    if (task.status === 'running' && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        let settled = false
        const finishWait = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          task.waiters.delete(finishWait)
          resolve()
        }
        const timer = setTimeout(finishWait, timeoutMs)
        task.waiters.add(finishWait)
        if (task.status !== 'running') finishWait()
      })
    }
    return this.result(task)
  }

  async interrupt(taskId: string): Promise<SpawnResult | undefined> {
    const task = this.tasks.get(taskId)
    if (!task) return undefined
    if (task.status === 'running') {
      task.interruptionRequested = true
      await terminateProcess(task.process, task.detached)
      const result = await this.wait(taskId, 5_000)
      if (result?.status === 'running') {
        task.stderr = appendLiveOutput(
          task.stderr,
          `${task.stderr ? '\n' : ''}Failed to confirm that the command process exited after interruption.`
        )
      }
      return this.result(task)
    }
    return this.result(task)
  }

  private result(task: ManagedCommandTask): SpawnResult {
    const out = truncateOutput(task.stdout)
    const err = truncateOutput(task.stderr)
    return {
      status: task.status,
      command: task.command,
      exitCode: task.exitCode,
      stdout: out.text,
      stderr: err.text,
      timedOut: false,
      waitTimedOut: task.status === 'running',
      background: false,
      taskId: task.taskId,
      pid: task.pid,
      startedAt: task.startedAt,
      elapsedMs: Math.max((task.completedAt || Date.now()) - task.startedAt, 0),
      truncated: out.truncated || err.truncated
    }
  }

  private publicEntry(task: ManagedCommandTask): CommandTaskEntry {
    return {
      taskId: task.taskId,
      pid: task.pid,
      command: task.command,
      sessionId: task.sessionId,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      shellType: task.shellType,
      status: task.status,
      exitCode: task.exitCode
    }
  }

  private prune(): void {
    const expiry = Date.now() - 15 * 60_000
    for (const [taskId, task] of this.tasks) {
      if (task.status !== 'running' && (task.completedAt || task.startedAt) < expiry) {
        this.tasks.delete(taskId)
      }
    }
    if (this.tasks.size < 100) return
    const completed = [...this.tasks.values()]
      .filter((task) => task.status !== 'running')
      .sort((left, right) => (left.completedAt || 0) - (right.completedAt || 0))
    for (const task of completed.slice(0, this.tasks.size - 99)) this.tasks.delete(task.taskId)
  }
}

let commandRegistryInstance: CommandTaskRegistry | null = null
export function getCommandTaskRegistry(): CommandTaskRegistry {
  if (!commandRegistryInstance) commandRegistryInstance = new CommandTaskRegistry()
  return commandRegistryInstance
}

export class SpawnRunner {
  run(opts: RunOptions): Promise<SpawnResult> {
    if (opts.abortSignal?.aborted) {
      return Promise.resolve({
        status: 'interrupted',
        exitCode: null,
        stdout: '',
        stderr: 'Execution interrupted before process start.',
        timedOut: false,
        waitTimedOut: false,
        background: opts.run_in_background === true,
        truncated: false
      })
    }
    return opts.run_in_background ? this.runBackground(opts) : this.runForeground(opts)
  }

  private buildArgs(opts: RunOptions): { exe: string; args: string[] } {
    if (opts.shell === 'powershell') {
      return { exe: opts.executable || 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', opts.command] }
    }
    return { exe: opts.executable || 'bash', args: ['-c', opts.command] }
  }

  private runForeground(opts: RunOptions): Promise<SpawnResult> {
    const { exe, args } = this.buildArgs(opts)
    const detached = process.platform !== 'win32'
    const proc = spawn(exe, args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      windowsHide: true,
      detached
    })
    const registry = getCommandTaskRegistry()
    const taskId = registry.add(proc, opts, detached)
    return registry.wait(taskId, opts.timeout || 0) as Promise<SpawnResult>
  }

  wait(taskId: string, timeoutMs: number): Promise<SpawnResult | undefined> {
    return getCommandTaskRegistry().wait(taskId, timeoutMs)
  }

  interrupt(taskId: string): Promise<SpawnResult | undefined> {
    return getCommandTaskRegistry().interrupt(taskId)
  }

  private runBackground(opts: RunOptions): Promise<SpawnResult> {
    const { exe, args } = this.buildArgs(opts)
    const stdoutFile = path.join(os.tmpdir(), `codez-bg-${Date.now()}-${Math.random().toString(36).slice(2)}.out`)
    const stderrFile = path.join(os.tmpdir(), `codez-bg-${Date.now()}-${Math.random().toString(36).slice(2)}.err`)
    const outFd = fs.openSync(stdoutFile, 'w')
    const errFd = fs.openSync(stderrFile, 'w')

    const proc = spawn(exe, args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      detached: true,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true
    })
    fs.closeSync(outFd)
    fs.closeSync(errFd)

    const pid = proc.pid
    if (typeof pid !== 'number') {
      // spawn 失败（极少见，例如可执行文件不存在于 detached 路径）——不留无 pid 的后台登记
      return Promise.resolve({
        status: 'failed',
        exitCode: 1,
        stdout: '',
        stderr: 'Failed to spawn background process (no pid).',
        timedOut: false,
        waitTimedOut: false,
        background: true,
        truncated: false
      })
    }
    const registry = getBackgroundTaskRegistry()
    const taskId = registry.add({ pid, stdoutFile, stderrFile, startedAt: Date.now(), shellType: opts.shell })
    const abortProcess = () => {
      registry.remove(taskId)
      void terminateProcess(proc, true)
    }
    opts.abortSignal?.addEventListener('abort', abortProcess, { once: true })
    if (opts.abortSignal?.aborted) abortProcess()
    try { proc.unref() } catch {}

    return Promise.resolve({
      status: 'running',
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      waitTimedOut: false,
      background: true,
      pid,
      stdoutFile,
      stderrFile,
      truncated: false
    })
  }
}
