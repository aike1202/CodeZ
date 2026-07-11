import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { ModelLedgerStore } from '../main/services/context/ModelLedgerStore'
import { SessionRuntimeCoordinator } from '../main/services/context/SessionRuntimeCoordinator'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codez-runtime-'))
  dirs.push(root)
  const ledger = new ModelLedgerStore(root)
  return { ledger, runtime: new SessionRuntimeCoordinator(ledger) }
}

describe('SessionRuntimeCoordinator', () => {
  it('allows an image-only turn and persists attachment metadata', async () => {
    const { ledger, runtime } = await fixture()
    const attachment = {
      id: 'img1', kind: 'image' as const, name: 'photo.jpg', mimeType: 'image/jpeg' as const,
      width: 800, height: 600, sizeBytes: 123, storageKey: 'attachment:sessions/s1/img1',
      scope: 'session' as const, sessionId: 's1'
    }
    const turn = await runtime.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: '', attachments: [attachment]
    })
    const message = (await ledger.load('s1')).scopes.main.activeMessages[0]
    expect(message.attachments).toEqual([attachment])
    await runtime.completeTurn(turn, { stopReason: 'stop' })
  })

  it('persists user, assistant, tool, and completion in protocol order', async () => {
    const { ledger, runtime } = await fixture()
    const turn = await runtime.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: 'read', providerId: 'p1', model: 'm1'
    })
    await runtime.recordAssistant(turn, {
      content: '', toolCalls: [{ id: 'c1', name: 'Read', arguments: '{}' }]
    })
    await runtime.recordToolResult(turn, { callId: 'c1', name: 'Read', content: 'ok', status: 'success' })
    await runtime.recordAssistant(turn, { content: 'done' })
    await runtime.completeTurn(turn, { stopReason: 'stop' })

    const state = await ledger.load('s1')
    expect(state.scopes.main.activeMessages.map((message) => message.role)).toEqual([
      'user', 'assistant', 'tool', 'assistant'
    ])
    expect(state.scopes.main.lastCompletedTurnId).toBe(turn.turnId)
  })

  it('allows different scopes concurrently but rejects two turns in one scope', async () => {
    const { runtime } = await fixture()
    const main = await runtime.beginTurn({ sessionId: 's1', contextScopeId: 'main', text: 'main' })
    await expect(runtime.beginTurn({ sessionId: 's1', contextScopeId: 'main', text: 'again' }))
      .rejects.toThrow('already has an active turn')
    const sub = await runtime.beginTurn({ sessionId: 's1', contextScopeId: 'subagent:r1', text: 'sub' })
    await runtime.completeTurn(main, { stopReason: 'stop' })
    await runtime.completeTurn(sub, { stopReason: 'stop' })
  })

  it('records interrupted results for unfinished calls', async () => {
    const { ledger, runtime } = await fixture()
    const turn = await runtime.beginTurn({ sessionId: 's1', contextScopeId: 'main', text: 'read' })
    await runtime.recordAssistant(turn, {
      content: '', toolCalls: [{ id: 'c1', name: 'Read', arguments: '{}' }]
    })
    await runtime.interruptTurn(turn, 'abort')
    const messages = (await ledger.load('s1')).scopes.main.activeMessages
    expect(messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'c1', status: 'interrupted' })
  })
})
