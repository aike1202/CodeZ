import { afterEach, describe, expect, it } from 'vitest'
import { appendFile, mkdtemp, readFile, rm } from 'fs/promises'
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
})
