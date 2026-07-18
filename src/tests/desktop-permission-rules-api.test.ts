import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
  Channel: class<T> {
    onmessage?: (message: T) => void
  }
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))

import { desktopApi } from '../renderer/src/shared/desktop/api'

const workspace = { id: 'workspace-1', rootPath: 'C:\\workspace' }
const rule = {
  filename: 'AGENTS.md',
  scope: 'workspace' as const,
  path: 'C:\\workspace\\AGENTS.md',
  content: 'Use focused tests.',
  projectId: workspace.id,
  enabled: true
}

let originalWindow: unknown

function setWindow(value: unknown): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value,
    writable: true
  })
}

describe('desktop permission and rules adapter', () => {
  beforeEach(() => {
    originalWindow = (globalThis as { window?: unknown }).window
    tauriMocks.invoke.mockReset()
  })

  afterEach(() => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window')
      return
    }
    setWindow(originalWindow)
  })

  it('maps permission and rules operations to their Tauri commands', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    tauriMocks.invoke
      .mockResolvedValueOnce('auto')
      .mockResolvedValueOnce('full-access')
      .mockResolvedValueOnce([rule])
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)

    await expect(desktopApi.permission.getMode(workspace.rootPath)).resolves.toBe('auto')
    await expect(desktopApi.permission.setMode(workspace.rootPath, 'full-access')).resolves.toBe('full-access')
    await expect(desktopApi.rules.getList([workspace])).resolves.toEqual([rule])
    await expect(desktopApi.rules.save(rule, workspace.rootPath)).resolves.toBe(true)
    await expect(desktopApi.rules.delete(rule.path)).resolves.toBe(true)
    await expect(desktopApi.rules.rename(rule.path, 'team.md', workspace.rootPath, 'workspace')).resolves.toBe(true)

    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['permission_mode_get', { rootPath: workspace.rootPath }],
      ['permission_mode_set', { rootPath: workspace.rootPath, mode: 'full-access' }],
      ['rules_get_list', { workspaces: [workspace] }],
      ['rules_save', { rule, workspaceRoot: workspace.rootPath }],
      ['rules_delete', { rulePath: rule.path }],
      ['rules_rename', {
        oldPath: rule.path,
        newFilename: 'team.md',
        workspaceRoot: workspace.rootPath,
        scope: 'workspace'
      }]
    ])
  })

})
