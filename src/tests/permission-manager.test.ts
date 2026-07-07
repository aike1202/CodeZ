import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import { PermissionManager } from '../main/services/PermissionManager'
import { PermissionRuleStore } from '../main/services/PermissionRuleStore'

vi.mock('electron', () => ({
  app: { getPath: () => path.resolve('/tmp/codez-test-user-data') }
}))

describe('PermissionManager', () => {
  const pm = PermissionManager.getInstance()
  const workspaceRoot = path.resolve('/tmp/codez-workspace')

  it('应正确识别安全验证命令', () => {
    expect(pm.getCommandRisk('git status')).toBe('safe')
    expect(pm.getCommandRisk('git diff -- src/main.ts')).toBe('safe')
    expect(pm.getCommandRisk('git log')).toBe('safe')
  })

  it('应正确识别写入、网络和破坏性命令', () => {
    expect(pm.getCommandRisk('npm test')).toBe('unknown')
    expect(pm.getCommandRisk('npm run test')).toBe('write')
    expect(pm.getCommandRisk('npm run typecheck')).toBe('write')
    expect(pm.getCommandRisk('npm run build')).toBe('write')
    expect(pm.getCommandRisk('npm install')).toBe('network')
    expect(pm.getCommandRisk('npm i lodash')).toBe('network')
    expect(pm.getCommandRisk('yarn add react')).toBe('network')
    expect(pm.getCommandRisk('pnpm add react')).toBe('network')
    expect(pm.getCommandRisk('curl https://example.com')).toBe('network')
    expect(pm.getCommandRisk('wget https://example.com/file')).toBe('network')
    expect(pm.getCommandRisk('rm -rf dist')).toBe('destructive')
    expect(pm.getCommandRisk('git reset --hard HEAD')).toBe('destructive')
    expect(pm.getCommandRisk('git clean -fd')).toBe('destructive')
    expect(pm.getCommandRisk('npm test && rm -rf /')).toBe('destructive') // Injection guard
  })

  it('Bash 支持 command 参数名', () => {
    expect(pm.checkToolPermission('Bash', { command: 'npm run test' }, workspaceRoot)).toBe('allow')
    expect(pm.checkToolPermission('Bash', { command: 'npm install' }, workspaceRoot)).toBe('ask')
    expect(pm.checkToolPermission('PowerShell', { command: 'git status' }, workspaceRoot)).toBe('allow')
  })

  it('只读工具应 allow，rollback 和写入工具应 allow(边界内)', () => {
    expect(pm.checkToolPermission('Read', {}, workspaceRoot)).toBe('allow')
    expect(pm.checkToolPermission('Glob', {}, workspaceRoot)).toBe('allow')
    expect(pm.checkToolPermission('update_resume_state', {}, workspaceRoot)).toBe('allow')
    expect(pm.checkToolPermission('TaskGet', {}, workspaceRoot)).toBe('allow')
    expect(pm.checkToolPermission('rollback_last_edit', {}, workspaceRoot)).toBe('ask')
    expect(pm.checkToolPermission('Edit', { file_path: 'src/main.ts' }, workspaceRoot)).toBe('allow')
  })

  it('写入 workspace 外路径应 deny', () => {
    const outsidePath = path.resolve('/tmp/outside.txt')
    expect(pm.checkToolPermission('Edit', { file_path: outsidePath }, workspaceRoot)).toBe('deny')
    expect(pm.checkToolPermission('Write', { file_path: outsidePath }, workspaceRoot)).toBe('deny')
  })

  it('项目级命令规则仅对当前 workspace 生效', async () => {
    const testRoot = path.resolve(process.cwd(), 'tmp-permission-test', 'permission-manager-workspace-rules')
    const projectWorkspace = path.join(testRoot, 'workspace-a')
    const otherWorkspace = path.join(testRoot, 'workspace-b')

    try {
      await PermissionRuleStore.getInstance().addRule('npm install *', 'workspace', projectWorkspace)

      expect(pm.checkToolPermission('Bash', { command: 'npm install lodash' }, projectWorkspace)).toBe('allow')
      expect(pm.checkToolPermission('Bash', { command: 'npm install lodash' }, otherWorkspace)).toBe('ask')
    } finally {
      await fs.rm(testRoot, { recursive: true, force: true })
    }
  })

  it('通配符规则不能放行更高风险命令', async () => {
    const testRoot = path.resolve(process.cwd(), 'tmp-permission-test', 'permission-manager-risk-bound-rules')

    try {
      await PermissionRuleStore.getInstance().addRule('git *', 'session')
      await PermissionRuleStore.getInstance().addRule('npm *', 'workspace', testRoot)

      expect(pm.checkToolPermission('Bash', { command: 'git status --short' }, testRoot)).toBe('allow')
      expect(pm.checkToolPermission('Bash', { command: 'git reset --hard HEAD' }, testRoot)).toBe('ask')
      expect(pm.checkToolPermission('Bash', { command: 'npm install lodash' }, testRoot)).toBe('allow')
      expect(pm.checkToolPermission('Bash', { command: 'npm install lodash && rm -rf dist' }, testRoot)).toBe('ask')
    } finally {
      await fs.rm(testRoot, { recursive: true, force: true })
    }
  })

  it('deny 命令规则优先于 allow 命令规则', async () => {
    const testRoot = path.resolve(process.cwd(), 'tmp-permission-test', 'permission-manager-deny-rules')

    try {
      await PermissionRuleStore.getInstance().addRule('git *', 'session', undefined, 'allow')
      await PermissionRuleStore.getInstance().addRule('git push *', 'session', undefined, 'deny')
      await PermissionRuleStore.getInstance().addRule('npm install *', 'workspace', testRoot, 'allow')
      await PermissionRuleStore.getInstance().addRule('npm install bad-package', 'workspace', testRoot, 'deny')

      expect(pm.checkToolPermission('Bash', { command: 'git status --short' }, testRoot)).toBe('allow')
      expect(pm.checkToolPermission('Bash', { command: 'git push origin main' }, testRoot)).toBe('deny')
      expect(pm.checkToolPermission('Bash', { command: 'npm install lodash' }, testRoot)).toBe('allow')
      expect(pm.checkToolPermission('Bash', { command: 'npm install bad-package' }, testRoot)).toBe('deny')
    } finally {
      await fs.rm(testRoot, { recursive: true, force: true })
    }
  })
})
