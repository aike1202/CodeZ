import { describe, it, expect, vi } from 'vitest'
import * as path from 'path'
import { PermissionManager } from '../main/services/PermissionManager'

vi.mock('electron', () => ({
  app: { getPath: () => path.resolve('/tmp/codez-test-user-data') }
}))

describe('PermissionManager — Claude 工具名映射', () => {
  const pm = PermissionManager.getInstance()
  const ws = path.resolve('/tmp/codez-ws')

  it('只读/无破坏工具 allow', () => {
    for (const name of ['Read', 'NotebookEdit', 'Glob', 'Grep', 'Skill', 'PushNotification', 'AskUserQuestion']) {
      expect(pm.checkToolPermission(name, {}, ws)).toBe('allow')
    }
  })

  it('Edit/Write：workspace 内 allow，越界 deny', () => {
    expect(pm.checkToolPermission('Edit', { file_path: path.join(ws, 'a.ts') }, ws)).toBe('allow')
    expect(pm.checkToolPermission('Write', { file_path: path.join(ws, 'a.ts') }, ws)).toBe('allow')
    expect(pm.checkToolPermission('Edit', { file_path: path.resolve('/tmp/outside.ts') }, ws)).toBe('deny')
    expect(pm.checkToolPermission('Write', { file_path: path.resolve('/tmp/outside.ts') }, ws)).toBe('deny')
  })

  it('Bash/PowerShell 复用 getCommandRisk', () => {
    // npm run test is write (level 1), so auto-approve-safe returns allow
    expect(pm.checkToolPermission('Bash', { command: 'npm run test' }, ws)).toBe('allow')
    expect(pm.checkToolPermission('Bash', { command: 'npm install' }, ws)).toBe('ask')
    expect(pm.checkToolPermission('Bash', { command: 'rm -rf dist' }, ws)).toBe('ask')
    expect(pm.checkToolPermission('PowerShell', { command: 'git status' }, ws)).toBe('allow')
    expect(pm.checkToolPermission('PowerShell', { command: 'curl http://x' }, ws)).toBe('ask')
  })

  it('write_to_file 等工具现在走写工具分支', () => {
    expect(pm.checkToolPermission('write_to_file', { file_path: path.join(ws, 'a.ts') }, ws)).toBe('allow')
    expect(pm.checkToolPermission('replace_file_content', { file_path: path.join(ws, 'a.ts') }, ws)).toBe('allow')
    expect(pm.checkToolPermission('multi_replace_file_content', { file_path: path.join(ws, 'a.ts') }, ws)).toBe('allow')
  })

  it('createPermissionRequest：Bash/PowerShell 计算 risk 与 description', () => {
    const r1 = pm.createPermissionRequest('Bash', { command: 'npm install' })
    expect(r1.risk).toBe('network')
    expect(r1.description).toContain('npm install')
    const r2 = pm.createPermissionRequest('Edit', { file_path: 'a.ts' })
    expect(r2.risk).toBe('write')
    expect(r2.description).toContain('a.ts')
  })
})
