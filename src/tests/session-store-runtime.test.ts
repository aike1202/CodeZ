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

  it('preserves the main-process runtime reference when the renderer saves stale UI state', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'codez-session-'))
    const file = path.join(root, 'sessions.json')
    const store = new SessionStore(file)
    await store.save({
      id: 's1', projectId: 'p1', summary: 'x', relativeTime: 'now',
      messages: [{ id: 'm1', role: 'agent', content: 'before migration' }]
    })
    await store.setRuntimeRef('s1', {
      schemaVersion: 2,
      ledgerVersion: 1,
      migratedAt: '2026-07-10T00:00:00.000Z',
      legacySourceHash: 'source-hash',
      legacyImportMode: 'summary'
    })

    await store.save({
      id: 's1', projectId: 'p1', summary: 'x', relativeTime: 'now',
      messages: [{ id: 'm2', role: 'agent', content: 'renderer update' }],
      runtime: {
        schemaVersion: 2,
        ledgerVersion: 1,
        legacySourceHash: 'stale-source-hash'
      }
    })

    expect(store.get('s1')?.messages[0].content).toBe('renderer update')
    expect(store.get('s1')?.runtime).toMatchObject({
      schemaVersion: 2,
      legacySourceHash: 'source-hash',
      legacyImportMode: 'summary'
    })
  })

  it('preserves and merges main-process tool activations across stale renderer saves', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'codez-session-'))
    const file = path.join(root, 'sessions.json')
    const store = new SessionStore(file)
    await store.save({
      id: 's1', projectId: 'p1', summary: 'x', relativeTime: 'now', messages: []
    })

    await store.addActivatedDeferredTools('s1', 'main', ['WebSearch'])
    const staleRendererSnapshot = {
      id: 's1', projectId: 'p1', summary: 'updated', relativeTime: 'now', messages: [],
      toolRuntime: { activatedDeferredTools: { main: ['WebSearch'] } }
    }
    await store.addActivatedDeferredTools('s1', 'main', ['NotebookEdit'])
    await store.addActivatedDeferredTools('s1', 'subagent:worker-1', ['WebFetch'])
    await store.save({
      ...staleRendererSnapshot,
      summary: 'renderer snapshot'
    })

    const reloaded = new SessionStore(file)
    await reloaded.load()
    expect(reloaded.get('s1')?.toolRuntime?.activatedDeferredTools?.main).toEqual([
      'WebSearch',
      'NotebookEdit'
    ])
    expect(reloaded.get('s1')?.toolRuntime?.activatedDeferredTools?.['subagent:worker-1']).toEqual([
      'WebFetch'
    ])
    expect(reloaded.get('s1')?.summary).toBe('renderer snapshot')
  })

  it('preserves durable Agent records and mailbox messages across stale renderer saves', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'codez-session-'))
    const file = path.join(root, 'sessions.json')
    const store = new SessionStore(file)
    await store.save({
      id: 's1', projectId: 'p1', summary: 'x', relativeTime: 'now', messages: []
    })

    await store.setAgentRecords('s1', [{
      id: 'agent-1',
      sessionId: 's1',
      parentAgentId: '/root',
      parentPath: '/root',
      path: '/root/explore_auth',
      type: 'Explore',
      taskName: 'explore_auth',
      description: 'Explore auth',
      status: 'completed',
      contextScopeId: 'subagent:agent-1',
      createdAt: 1,
      updatedAt: 2,
      completedAt: 2,
      runCount: 1,
      launch: {
        context: 'Known auth context',
        permissionScope: { allowBash: true, allowedWriteFiles: [] },
      },
      result: {
        status: 'completed',
        report: '## Result\n\nDone.',
        conclusion: 'Done.',
        toolCallCount: 1,
        filesExamined: ['src/auth.ts'],
      },
    }])
    await store.setAgentMessages('s1', [{
      id: 'message-1',
      sessionId: 's1',
      type: 'FINAL_ANSWER',
      author: '/root/explore_auth',
      recipient: '/root',
      payload: '## Result\n\nDone.',
      createdAt: 3,
    }])

    await store.save({
      id: 's1', projectId: 'p1', summary: 'renderer update', relativeTime: 'now', messages: []
    })

    const reloaded = new SessionStore(file)
    await reloaded.load()
    expect(reloaded.get('s1')?.agentRuntime).toMatchObject({
      version: 1,
      agents: [{
        id: 'agent-1',
        launch: { context: 'Known auth context' },
        result: { report: '## Result\n\nDone.' },
      }],
      messages: [{ id: 'message-1', type: 'FINAL_ANSWER' }],
    })
  })

  it('serializes renderer saves and tool activation patches without cross-field loss', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'codez-session-'))
    const file = path.join(root, 'sessions.json')
    const store = new SessionStore(file)
    const base = (id: string) => ({
      id, projectId: 'p1', summary: 'initial', relativeTime: 'now', messages: []
    })
    await store.save(base('patch-first'))
    await store.save(base('save-first'))

    await Promise.all([
      store.addActivatedDeferredTools('patch-first', 'main', ['WebSearch']),
      store.save({ ...base('patch-first'), summary: 'renderer after patch' })
    ])
    await Promise.all([
      store.save({ ...base('save-first'), summary: 'renderer before patch' }),
      store.addActivatedDeferredTools('save-first', 'main', ['WebFetch'])
    ])

    expect(store.get('patch-first')).toMatchObject({
      summary: 'renderer after patch',
      toolRuntime: { activatedDeferredTools: { main: ['WebSearch'] } }
    })
    expect(store.get('save-first')).toMatchObject({
      summary: 'renderer before patch',
      toolRuntime: { activatedDeferredTools: { main: ['WebFetch'] } }
    })
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
