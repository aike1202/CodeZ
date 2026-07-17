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

let originalWindow: unknown

function setWindow(value: unknown): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value,
    writable: true
  })
}

describe('desktop skill adapter', () => {
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

  it('maps skill operations to Tauri commands with typed arguments', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    tauriMocks.invoke
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ hasUpdates: false, totalCount: 0, sources: [] })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)

    await desktopApi.skill.getAll('C:\\workspace')
    await desktopApi.skill.toggle('C:\\workspace', 'workspace-example', true)
    await desktopApi.skill.checkExternal()
    await desktopApi.skill.listExternal('C:\\workspace')
    await desktopApi.skill.importSingle('Codex', 'example', 'C:\\workspace')
    await desktopApi.skill.remove('C:\\workspace', 'workspace-example')

    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['skill_get_all', { rootPath: 'C:\\workspace' }],
      ['skill_toggle', { rootPath: 'C:\\workspace', id: 'workspace-example', enabled: true }],
      ['skill_check_external', { rootPath: undefined }],
      ['skill_list_external', { rootPath: 'C:\\workspace' }],
      ['skill_import_single', { sourceName: 'Codex', dirName: 'example', rootPath: 'C:\\workspace' }],
      ['skill_remove', { rootPath: 'C:\\workspace', id: 'workspace-example' }]
    ])
  })

  it('uses the frozen Electron skill API only at the adapter boundary', async () => {
    const skill = {
      getAll: vi.fn().mockResolvedValue([]),
      toggle: vi.fn().mockResolvedValue(undefined),
      checkExternal: vi.fn().mockResolvedValue({ hasUpdates: false, totalCount: 0, sources: [] }),
      listExternal: vi.fn().mockResolvedValue([]),
      importSingle: vi.fn().mockResolvedValue(true),
      remove: vi.fn().mockResolvedValue(true)
    }
    setWindow({ api: { skill } })

    await desktopApi.skill.getAll()
    await desktopApi.skill.toggle(null, 'global-example', false)
    await desktopApi.skill.checkExternal()
    await desktopApi.skill.listExternal()
    await desktopApi.skill.importSingle('Claude', 'example')
    await desktopApi.skill.remove(null, 'global-example')

    expect(tauriMocks.invoke).not.toHaveBeenCalled()
    expect(skill.getAll).toHaveBeenCalledWith(null)
    expect(skill.toggle).toHaveBeenCalledWith(null, 'global-example', false)
    expect(skill.checkExternal).toHaveBeenCalledWith(undefined)
    expect(skill.listExternal).toHaveBeenCalledWith(undefined)
    expect(skill.importSingle).toHaveBeenCalledWith('Claude', 'example', undefined)
    expect(skill.remove).toHaveBeenCalledWith(null, 'global-example')
  })
})
