import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { WorkspacePermissionStore } from '../main/services/permission/workspacePermissionStore'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('WorkspacePermissionStore', () => {
  it('defaults to auto and persists full access per workspace', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-mode-'))
    dirs.push(dir)
    const file = path.join(dir, 'workspace-permissions.json')
    const store = new WorkspacePermissionStore(file, 'win32')

    expect(await store.getMode('C:\\Repo')).toBe('auto')
    await store.setMode('C:\\Repo', 'full-access')

    const reloaded = new WorkspacePermissionStore(file, 'win32')
    expect(await reloaded.getMode('c:\\repo')).toBe('full-access')
    expect(JSON.parse(await readFile(file, 'utf8')).workspaces).toBeTruthy()
  })

  it('ignores invalid persisted modes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-mode-'))
    dirs.push(dir)
    const file = path.join(dir, 'workspace-permissions.json')
    await writeFile(file, '{"workspaces":{"/repo":"unsafe"}}', 'utf8')
    expect(await new WorkspacePermissionStore(file, 'linux').getMode('/repo')).toBe('auto')
  })
})
