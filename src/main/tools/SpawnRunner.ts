// src/main/tools/SpawnRunner.ts
import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface SpawnResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  background: boolean
  pid?: number
  stdoutFile?: string
  stderrFile?: string
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
}

export interface BackgroundTaskEntry {
  pid: number
  stdoutFile: string
  stderrFile: string
  startedAt: number
  shellType: 'bash' | 'powershell'
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

export class SpawnRunner {
  run(opts: RunOptions): Promise<SpawnResult> {
    return opts.run_in_background ? this.runBackground(opts) : this.runForeground(opts)
  }

  private buildArgs(opts: RunOptions): { exe: string; args: string[] } {
    if (opts.shell === 'powershell') {
      return { exe: opts.executable || 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', opts.command] }
    }
    return { exe: opts.executable || 'bash', args: ['-c', opts.command] }
  }

  private runForeground(opts: RunOptions): Promise<SpawnResult> {
    return new Promise((resolve) => {
      const { exe, args } = this.buildArgs(opts)
      const proc = spawn(exe, args, { cwd: opts.cwd, env: opts.env || process.env, windowsHide: true })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let timer: NodeJS.Timeout | null = null

      proc.stdout?.on('data', (d) => { stdout += d.toString() })
      proc.stderr?.on('data', (d) => { stderr += d.toString() })

      const finish = (exitCode: number | null) => {
        if (timer) clearTimeout(timer)
        const out = truncateOutput(stdout)
        const err = truncateOutput(stderr)
        resolve({
          exitCode,
          stdout: out.text,
          stderr: err.text,
          timedOut,
          background: false,
          pid: proc.pid,
          truncated: out.truncated || err.truncated
        })
      }

      if (opts.timeout && opts.timeout > 0) {
        timer = setTimeout(() => {
          timedOut = true
          try { proc.kill('SIGKILL') } catch {}
        }, opts.timeout)
      }

      proc.on('error', () => finish(1))
      proc.on('close', (code) => finish(code))
    })
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
    getBackgroundTaskRegistry().add({ pid, stdoutFile, stderrFile, startedAt: Date.now(), shellType: opts.shell })
    try { proc.unref() } catch {}

    return Promise.resolve({
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      background: true,
      pid,
      stdoutFile,
      stderrFile,
      truncated: false
    })
  }
}
