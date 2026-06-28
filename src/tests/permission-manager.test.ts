import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { PermissionManager } from '../main/services/PermissionManager'

describe('PermissionManager', () => {
  const pm = PermissionManager.getInstance()
  const workspaceRoot = path.resolve('/tmp/codez-workspace')

  it('应正确识别安全验证命令', () => {
    expect(pm.getCommandRisk('npm test')).toBe('safe')
    expect(pm.getCommandRisk('npm run test')).toBe('safe')
    expect(pm.getCommandRisk('npm run typecheck')).toBe('safe')
    expect(pm.getCommandRisk('npm run build')).toBe('safe')
    expect(pm.getCommandRisk('git status')).toBe('safe')
    expect(pm.getCommandRisk('git diff -- src/main.ts')).toBe('safe')
  })

  it('应正确识别写入、网络和破坏性命令', () => {
    expect(pm.getCommandRisk('npm install')).toBe('write')
    expect(pm.getCommandRisk('npm i lodash')).toBe('write')
    expect(pm.getCommandRisk('yarn add react')).toBe('write')
    expect(pm.getCommandRisk('pnpm add react')).toBe('write')
    expect(pm.getCommandRisk('curl https://example.com')).toBe('network')
    expect(pm.getCommandRisk('wget https://example.com/file')).toBe('network')
    expect(pm.getCommandRisk('rm -rf dist')).toBe('destructive')
    expect(pm.getCommandRisk('git reset --hard HEAD')).toBe('destructive')
    expect(pm.getCommandRisk('git clean -fd')).toBe('destructive')
  })

  it('run_command 应支持 commandLine / CommandLine / command 参数名', () => {
    expect(pm.checkToolPermission('run_command', { commandLine: 'npm test' }, workspaceRoot)).toBe('allow')
    expect(pm.checkToolPermission('run_command', { CommandLine: 'npm run typecheck' }, workspaceRoot)).toBe('allow')
    expect(pm.checkToolPermission('run_command', { command: 'git status' }, workspaceRoot)).toBe('allow')
    expect(pm.checkToolPermission('run_command', { commandLine: 'npm install' }, workspaceRoot)).toBe('ask')
  })

  it('只读工具应 allow，rollback 和写入工具应 ask', () => {
    expect(pm.checkToolPermission('search', {}, workspaceRoot)).toBe('allow')
    expect(pm.checkToolPermission('read_files', {}, workspaceRoot)).toBe('allow')
    expect(pm.checkToolPermission('get_project_snapshot', {}, workspaceRoot)).toBe('allow')
    expect(pm.checkToolPermission('rollback_last_edit', {}, workspaceRoot)).toBe('ask')
    expect(pm.checkToolPermission('apply_patch', { filePath: 'src/main.ts' }, workspaceRoot)).toBe('ask')
  })

  it('写入 workspace 外路径应 deny', () => {
    const outsidePath = path.resolve('/tmp/outside.txt')
    expect(pm.checkToolPermission('apply_patch', { filePath: outsidePath }, workspaceRoot)).toBe('deny')
  })
})
