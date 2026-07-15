// src/tests/spawn-runner.test.ts
import { describe, it, expect } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import {
  SpawnRunner,
  truncateOutput,
  getBackgroundTaskRegistry,
  getCommandTaskRegistry
} from '../main/tools/SpawnRunner'

const SHELL = process.platform === 'win32' ? 'powershell' : 'bash'
const EXEC = process.platform === 'win32' ? 'powershell.exe' : 'bash'
function echoCmd(): string {
  return SHELL === 'powershell' ? 'Write-Output hello' : 'echo hello'
}
function sleepCmd(): string {
  return SHELL === 'powershell' ? 'Start-Sleep -Seconds 3' : 'sleep 3'
}

describe('truncateOutput', () => {
  it('短文本不截断', () => {
    const r = truncateOutput('short')
    expect(r.truncated).toBe(false)
    expect(r.text).toBe('short')
  })
  it('长文本保留 head+tail 并标注', () => {
    const big = 'A'.repeat(5000)
    const r = truncateOutput(big)
    expect(r.truncated).toBe(true)
    expect(r.text).toContain('[System Note:')
    expect(r.text.length).toBeLessThan(big.length)
    expect(r.text.startsWith('A')).toBe(true)
    expect(r.text.endsWith('A')).toBe(true)
  })
})

describe('SpawnRunner', () => {
  const cwd = process.cwd()

  it('前台执行：返回 exitCode 0 与 stdout', async () => {
    const runner = new SpawnRunner()
    const result = await runner.run({ command: echoCmd(), cwd, shell: SHELL, executable: EXEC, timeout: 15000 })
    expect(result.background).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello')
  }, 30000)

  it('wait timeout yields control without terminating the command', async () => {
    const runner = new SpawnRunner()
    const result = await runner.run({ command: sleepCmd(), cwd, shell: SHELL, executable: EXEC, timeout: 500 })
    expect(result).toMatchObject({ status: 'running', waitTimedOut: true, timedOut: false })
    expect(result.taskId).toBeTruthy()
    const interrupted = await runner.interrupt(result.taskId!)
    expect(interrupted?.status).toBe('interrupted')
  }, 15000)

  it('waits again for the same task and returns its final output', async () => {
    const runner = new SpawnRunner()
    const command = SHELL === 'powershell'
      ? 'Start-Sleep -Milliseconds 700; Write-Output finished'
      : 'sleep 0.7; echo finished'
    const yielded = await runner.run({ command, cwd, shell: SHELL, executable: EXEC, timeout: 250 })
    expect(yielded.status).toBe('running')

    const completed = await runner.wait(yielded.taskId!, 5_000)
    expect(completed).toMatchObject({ status: 'completed', exitCode: 0, waitTimedOut: false })
    expect(completed?.stdout).toContain('finished')
  }, 15000)

  it('interrupts only the task bound to a tool call id', async () => {
    const runner = new SpawnRunner()
    const first = await runner.run({
      command: sleepCmd(), cwd, shell: SHELL, executable: EXEC, timeout: 250, toolCallId: 'tool-first'
    })
    const second = await runner.run({
      command: echoCmd(), cwd, shell: SHELL, executable: EXEC, timeout: 15_000, toolCallId: 'tool-second'
    })

    const interrupted = await getCommandTaskRegistry().interruptByToolCallId('tool-first')
    expect(interrupted?.status).toBe('interrupted')
    expect(second.status).toBe('completed')
  }, 30000)

  it('background：立即返回 pid/stdoutFile 并登记注册表', async () => {
    const registry = getBackgroundTaskRegistry()
    const before = registry.list().length
    const runner = new SpawnRunner()
    const result = await runner.run({ command: sleepCmd(), cwd, shell: SHELL, executable: EXEC, run_in_background: true })
    expect(result.background).toBe(true)
    expect(typeof result.pid).toBe('number')
    expect(result.stdoutFile).toBeTruthy()
    expect(fs.existsSync(result.stdoutFile!)).toBe(true)
    expect(registry.list().length).toBeGreaterThan(before)
    // 清理：杀掉后台进程
    try { process.kill(result.pid!) } catch {}
  }, 15000)
})
