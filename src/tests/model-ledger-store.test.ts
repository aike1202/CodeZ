import { afterEach, describe, expect, it } from 'vitest'
import { appendFile, mkdtemp, readFile, readdir, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { ModelLedgerStore } from '../main/services/context/ModelLedgerStore'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createStore(): Promise<ModelLedgerStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codez-ledger-'))
  dirs.push(root)
  return new ModelLedgerStore(root)
}

describe('ModelLedgerStore', () => {
  it('shares a strict sequence while versioning scopes independently', async () => {
    const store = await createStore()
    const [main, sub] = await Promise.all([
      store.append('s1', 'main', 'user_message', { message: { id: 'u1' } as never }, 't1'),
      store.append('s1', 'subagent:r1', 'user_message', { message: { id: 'u2' } as never }, 't2')
    ])

    expect([main.sequence, sub.sequence].sort((a, b) => a - b)).toEqual([1, 2])
    expect(main.historyVersion).toBe(1)
    expect(sub.historyVersion).toBe(1)

    const lifecycle = await store.append('s1', 'main', 'turn_completed', {
      stopReason: 'stop',
      completedAt: '2026-07-10T00:00:01.000Z'
    }, 't1')
    expect(lifecycle.historyVersion).toBe(1)
  })

  it('serializes appends across independent store instances', async () => {
    const first = await createStore()
    const second = new ModelLedgerStore(first.runtimeRoot)

    await Promise.all(Array.from({ length: 12 }, (_, index) => {
      const store = index % 2 === 0 ? first : second
      return store.append('s1', 'main', 'user_message', {
        message: { id: `u${index}`, role: 'user', content: `message ${index}` } as never
      }, `t${index}`)
    }))

    const loaded = await new ModelLedgerStore(first.runtimeRoot).load('s1')
    const events = (await readFile(first.ledgerPath('s1'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { sequence: number })
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1)
    )
    expect(loaded.throughSequence).toBe(12)
    expect(loaded.scopes.main.historyVersion).toBe(12)
  })

  it('backs up and rebases a conflicting repairable ledger tail', async () => {
    const store = await createStore()
    await store.append('s1', 'main', 'user_message', {
      message: { id: 'u1', role: 'user', content: 'start' } as never
    }, 't1')
    await store.append('s1', 'main', 'assistant_message', {
      message: { id: 'a1', role: 'assistant', content: 'first writer' } as never
    }, 't1')

    const lines = (await readFile(store.ledgerPath('s1'), 'utf8')).trim().split('\n')
    const duplicate = JSON.parse(lines[1]) as Record<string, unknown> & {
      payload: { message: { id: string; content: string } }
    }
    duplicate.eventId = 's1:2:stale-writer'
    duplicate.payload.message.id = 'a2'
    duplicate.payload.message.content = 'stale writer'
    await appendFile(store.ledgerPath('s1'), `${JSON.stringify(duplicate)}\n`, 'utf8')

    const loaded = await new ModelLedgerStore(store.runtimeRoot).load('s1')
    const repaired = (await readFile(store.ledgerPath('s1'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { sequence: number; historyVersion: number })
    const sessionFiles = await readdir(store.sessionDirectory('s1'))

    expect(repaired.map((event) => event.sequence)).toEqual([1, 2, 3])
    expect(repaired.map((event) => event.historyVersion)).toEqual([1, 2, 3])
    expect(loaded.throughSequence).toBe(3)
    expect(loaded.scopes.main.activeMessages.map((message) => message.id)).toEqual(['u1', 'a1', 'a2'])
    expect(loaded.warnings).toContain('REPAIRED_CONFLICTING_TAIL')
    expect(sessionFiles.some((name) => name.startsWith('ledger.jsonl.conflict-') && name.endsWith('.bak')))
      .toBe(true)
  })

  it('does not repair a forward sequence gap', async () => {
    const store = await createStore()
    await store.append('s1', 'main', 'user_message', {
      message: { id: 'u1', role: 'user', content: 'start' } as never
    }, 't1')
    const first = JSON.parse((await readFile(store.ledgerPath('s1'), 'utf8')).trim()) as {
      eventId: string
      sequence: number
      historyVersion: number
      payload: { message: { id: string } }
    }
    first.eventId = 's1:3:missing-middle-event'
    first.sequence = 3
    first.historyVersion = 2
    first.payload.message.id = 'u3'
    await appendFile(store.ledgerPath('s1'), `${JSON.stringify(first)}\n`, 'utf8')

    await expect(new ModelLedgerStore(store.runtimeRoot).load('s1'))
      .rejects.toThrow('LEDGER_CORRUPTED: non-contiguous sequence')
    expect((await readdir(store.sessionDirectory('s1'))).some((name) => name.endsWith('.bak')))
      .toBe(false)
  })

  it('ignores a truncated final JSON record', async () => {
    const store = await createStore()
    await store.append('s1', 'main', 'user_message', { message: { id: 'u1' } as never }, 't1')
    await appendFile(store.ledgerPath('s1'), '{"schemaVersion":1', 'utf8')

    const loaded = await new ModelLedgerStore(store.runtimeRoot).load('s1')

    expect(loaded.throughSequence).toBe(1)
    expect(loaded.warnings).toContain('TRUNCATED_FINAL_RECORD')

    const repaired = new ModelLedgerStore(store.runtimeRoot)
    const next = await repaired.append('s1', 'main', 'turn_completed', {
      stopReason: 'stop', completedAt: '2026-07-10T00:00:01.000Z'
    }, 't1')
    expect(next.sequence).toBe(2)
    expect((await new ModelLedgerStore(store.runtimeRoot).load('s1')).throughSequence).toBe(2)
  })

  it('restores from snapshot and ignores log records below its watermark', async () => {
    const store = await createStore()
    await store.append('s1', 'main', 'user_message', { message: { id: 'u1' } as never }, 't1')
    await store.writeSnapshot('s1')
    await store.append('s1', 'main', 'assistant_message', { message: { id: 'a1' } as never }, 't1')

    const raw = await readFile(store.ledgerPath('s1'), 'utf8')
    expect(raw).toContain('assistant_message')
    const loaded = await new ModelLedgerStore(store.runtimeRoot).load('s1')
    expect(loaded.throughSequence).toBe(2)
    expect(loaded.scopes.main.historyVersion).toBe(2)
  })

  it('conditionally appends against the scope history version inside the ledger queue', async () => {
    const store = await createStore()
    await store.append('s1', 'main', 'user_message', { message: { id: 'u1' } as never }, 't1')

    const stale = await store.appendIfHistoryVersion(
      's1', 'main', 0, 'turn_completed', {
        stopReason: 'stop', completedAt: '2026-07-10T00:00:01.000Z'
      }, 't1'
    )
    const committed = await store.appendIfHistoryVersion(
      's1', 'main', 1, 'turn_completed', {
        stopReason: 'stop', completedAt: '2026-07-10T00:00:01.000Z'
      }, 't1'
    )

    expect(stale).toBeNull()
    expect(committed?.sequence).toBe(2)
  })

  it('serializes long-running maintenance within the same context scope', async () => {
    const store = await createStore()
    let releaseFirst!: () => void
    let markFirstEntered!: () => void
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve })
    const order: string[] = []
    const first = store.runScopeExclusive('s1', 'main', async () => {
      order.push('first:start')
      markFirstEntered()
      await gate
      order.push('first:end')
    })
    await firstEntered
    const second = store.runScopeExclusive('s1', 'main', async () => {
      order.push('second')
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(order).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })

  it('does not activate a legacy usage anchor without a request fingerprint', async () => {
    const store = await createStore()
    await store.append('s1', 'main', 'user_message', {
      message: { id: 'u1' } as never
    }, 't1')
    await store.append('s1', 'main', 'assistant_message', {
      message: { id: 'a1' } as never,
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }
    }, 't1')

    expect((await store.load('s1')).scopes.main.lastProviderUsage).toBeUndefined()

    await store.append('s1', 'main', 'user_message', {
      message: { id: 'u2' } as never,
      providerId: 'provider-current',
      model: 'model-current'
    }, 't2')

    const scope = (await store.load('s1')).scopes.main
    expect(scope.lastProviderUsage).toBeUndefined()
    expect(scope.lastProviderUsageMessageId).toBeUndefined()
    expect(scope.lastProviderUsageProviderId).toBeUndefined()
    expect(scope.lastProviderUsageModel).toBeUndefined()
    expect(scope.lastProviderUsageRequestFingerprint).toBeUndefined()
  })
})
