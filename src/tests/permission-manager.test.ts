import { describe, expect, it } from 'vitest'
import * as path from 'path'
import { PermissionManager } from '../main/services/PermissionManager'

const workspaceRoot = path.resolve('/tmp/codez-workspace')
const context = (mode: 'auto' | 'full-access') => ({ workspaceRoot, cwd: workspaceRoot, platform: process.platform, mode })

describe('PermissionManager', () => {
  const manager = new PermissionManager()

  it('allows reads and workspace writes in auto mode', async () => {
    expect((await manager.evaluateToolCall('Read', {}, context('auto'))).action).toBe('allow')
    expect((await manager.evaluateToolCall('Edit', { file_path: path.join(workspaceRoot, 'a.ts') }, context('auto'))).action).toBe('allow')
  })

  it('asks for network commands only in auto mode', async () => {
    expect((await manager.evaluateToolCall('Bash', { command: 'npm install react' }, context('auto'))).action).toBe('ask')
    expect((await manager.evaluateToolCall('Bash', { command: 'npm install react' }, context('full-access'))).action).toBe('allow')
  })

  it('asks for L4 in both modes', async () => {
    expect((await manager.evaluateToolCall('Bash', { command: 'sudo rm -rf /var/lib/example' }, context('auto'))).riskLevel).toBe(4)
    expect((await manager.evaluateToolCall('Bash', { command: 'sudo rm -rf /var/lib/example' }, context('full-access'))).action).toBe('ask')
  })
})
