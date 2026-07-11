import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { SessionStore } from '../main/services/SessionStore'

let root = ''

function imageAttachmentFixture() {
  return {
    id: 'img1',
    kind: 'image' as const,
    name: 'photo.jpg',
    mimeType: 'image/jpeg' as const,
    width: 800,
    height: 600,
    sizeBytes: 123,
    storageKey: 'attachment:sessions/s1/img1',
    scope: 'session' as const,
    sessionId: 's1'
  }
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

describe('SessionStore runtime schema', () => {
  it('round-trips image metadata while legacy messages remain valid', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'codez-session-'))
    const file = path.join(root, 'sessions.json')
    const store = new SessionStore(file)
    const attachment = imageAttachmentFixture()
    await store.save({
      id: 's1',
      projectId: 'p1',
      summary: 'x',
      relativeTime: 'now',
      messages: [
        { id: 'u1', role: 'user', content: 'inspect', attachments: [attachment] },
        { id: 'a1', role: 'agent', content: 'legacy-compatible' }
      ]
    })

    const reloaded = new SessionStore(file)
    await reloaded.load()
    expect(reloaded.get('s1')?.messages[0].attachments).toEqual([attachment])
    expect(reloaded.get('s1')?.messages[1]).not.toHaveProperty('attachments')
  })

  it('updates a runtime reference without changing UI messages', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'codez-session-'))
    const file = path.join(root, 'sessions.json')
    const store = new SessionStore(file)
    await store.save({
      id: 's1',
      projectId: 'p1',
      summary: 'x',
      relativeTime: 'now',
      messages: [{ id: 'm1', role: 'agent', content: 'complete UI output' }]
    })

    await store.setRuntimeRef('s1', {
      schemaVersion: 2,
      ledgerVersion: 1,
      migratedAt: '2026-07-10T00:00:00.000Z'
    })

    const reloaded = new SessionStore(file)
    await reloaded.load()
    expect(reloaded.get('s1')?.messages).toEqual([{ id: 'm1', role: 'agent', content: 'complete UI output' }])
    expect(reloaded.get('s1')?.runtime?.schemaVersion).toBe(2)
    expect(JSON.parse(await readFile(file, 'utf8')).sessions).toHaveLength(1)
  })

  it('throws and rolls back cache when persistence fails', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'codez-session-'))
    const file = path.join(root, 'sessions.json')
    const store = new SessionStore(file)
    await store.save({ id: 's1', projectId: 'p1', summary: 'x', relativeTime: 'now', messages: [] })
    const invalidTarget = path.join(root, 'directory-target')
    await import('fs/promises').then((fs) => fs.mkdir(invalidTarget))
    const broken = new SessionStore(invalidTarget)
    await expect(broken.save({ id: 's2', projectId: 'p1', summary: 'x', relativeTime: 'now', messages: [] })).rejects.toThrow()
    expect(broken.get('s2')).toBeUndefined()
  })
})
