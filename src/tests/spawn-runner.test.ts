// src/tests/spawn-runner.test.ts
import { describe, it, expect } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import { SpawnRunner, truncateOutput, getBackgroundTaskRegistry } from '../main/tools/SpawnRunner'

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

  it('timeout：返回 timedOut true', async () => {
    const runner = new SpawnRunner()
    const result = await runner.run({ command: sleepCmd(), cwd, shell: SHELL, executable: EXEC, timeout: 500 })
    expect(result.timedOut).toBe(true)
  }, 15000)

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
