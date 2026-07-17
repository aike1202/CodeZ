import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
  Channel: class<T> {
    onmessage?: (message: T) => void
  }
}))

import { desktopApi } from '../renderer/src/shared/desktop/api'
import { normalizeDesktopError } from '../renderer/src/shared/desktop/errors'

describe('desktop error mapping', () => {
  beforeEach(() => {
    tauriMocks.invoke.mockClear()
  })

  it('preserves structured command errors from Tauri', () => {
    const error = normalizeDesktopError({
      code: 'TIMEOUT',
      message: 'The operation timed out',
      retryable: true,
      correlationId: 'cmd-0001'
    })

    expect(error).toMatchObject({
      name: 'DesktopCommandError',
      code: 'TIMEOUT',
      message: 'The operation timed out',
      retryable: true,
      correlationId: 'cmd-0001'
    })
  })

  it('parses serialized command errors without losing the stable code', () => {
    const error = normalizeDesktopError(JSON.stringify({
      code: 'PERMISSION_DENIED',
      message: 'Approval was denied',
      retryable: false,
      correlationId: null
    }))

    expect(error.code).toBe('PERMISSION_DENIED')
  })

  it('accepts the generated process failure category at runtime', () => {
    const error = normalizeDesktopError({
      code: 'PROCESS_FAILED',
      message: 'The command exited unsuccessfully',
      retryable: false,
      correlationId: 'cmd-process-1'
    })

    expect(error.code).toBe('PROCESS_FAILED')
  })

  it('preserves retryable RUN_ACTIVE errors from session coordination', () => {
    const error = normalizeDesktopError(JSON.stringify({
      code: 'RUN_ACTIVE',
      message: 'The session has an active run',
      retryable: true,
      correlationId: 'cmd-run-active-1'
    }))

    expect(error).toMatchObject({
      name: 'DesktopCommandError',
      code: 'RUN_ACTIVE',
      message: 'The session has an active run',
      retryable: true,
      correlationId: 'cmd-run-active-1'
    })
  })

  it.each([
    ['HISTORY_REVERT_STALE', true],
    ['RECOVERY_REQUIRED', true]
  ] as const)('preserves the %s history recovery code', (code, retryable) => {
    const error = normalizeDesktopError({
      code,
      message: 'History revert requires a retry',
      retryable,
      correlationId: 'cmd-history-1'
    })

    expect(error).toMatchObject({ code, retryable, correlationId: 'cmd-history-1' })
  })

  it('preserves UNSUPPORTED errors instead of degrading them to INTERNAL', () => {
    const error = normalizeDesktopError({
      code: 'UNSUPPORTED',
      message: 'This operation is not supported on the current platform',
      retryable: false,
      correlationId: null
    })

    expect(error).toMatchObject({
      name: 'DesktopCommandError',
      code: 'UNSUPPORTED',
      message: 'This operation is not supported on the current platform',
      retryable: false,
      correlationId: null
    })
  })

  it('does not expose messages from unstructured errors', () => {
    const error = normalizeDesktopError(new Error('apiKey=secret-value'))

    expect(error).toMatchObject({
      code: 'INTERNAL',
      message: 'Desktop command failed',
      retryable: false,
      correlationId: null
    })
  })

  it('maps the typed workspace adapter to matching Tauri commands and arguments', async () => {
    const project = {
      id: 'project-1',
      rootPath: 'C:\\workspace',
      name: 'Workspace',
      projectType: 'rust',
      openedAt: '2026-07-16T00:00:00Z'
    }

    await desktopApi.workspace.openDirectory()
    await desktopApi.workspace.scanFileTree(project.rootPath)
    await desktopApi.workspace.getAllPaths(project.rootPath)
    await desktopApi.workspace.readFile('src/main.rs', project.rootPath)
    await desktopApi.workspace.detectProject(project.rootPath)
    await desktopApi.workspace.getRecentProjects()
    await desktopApi.workspace.addRecentProject(project)
    await desktopApi.workspace.removeRecentProject(project.id)
    await desktopApi.workspace.renameRecentProject(project.id, 'Renamed')

    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['workspace_open_directory', undefined],
      ['workspace_scan_file_tree', { rootPath: project.rootPath }],
      ['workspace_get_all_paths', { rootPath: project.rootPath }],
      ['workspace_read_file', { filePath: 'src/main.rs', rootPath: project.rootPath }],
      ['workspace_detect_project', { rootPath: project.rootPath }],
      ['workspace_get_recent_projects', undefined],
      ['workspace_add_recent_project', { project }],
      ['workspace_remove_recent_project', { id: project.id }],
      ['workspace_rename_recent_project', { id: project.id, newName: 'Renamed' }]
    ])
  })
})
