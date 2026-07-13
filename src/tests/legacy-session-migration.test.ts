import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { SessionStore } from '../main/services/SessionStore'
import { ModelLedgerStore } from '../main/services/context/ModelLedgerStore'
import { LegacySessionMigrationService } from '../main/services/context/LegacySessionMigrationService'
import type { CompactionSummaryV1 } from '../shared/types/context'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function summary(coveredThroughSequence: number): CompactionSummaryV1 {
  return {
    version: 1,
    goal: { currentObjective: 'continue task', requirements: [], successCriteria: [] },
    status: { phase: 'migration', completed: [], inProgress: [], nextActions: [] },
    decisions: [], facts: [], files: [], validation: [], errors: [],
    openQuestions: [], userInstructions: [], coveredThroughSequence
  }
}

async function fixture(summarize = vi.fn().mockResolvedValue(summary(0))) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codez-migration-'))
  dirs.push(root)
  const sessions = new SessionStore(path.join(root, 'sessions.json'))
  await sessions.save({
    id: 's1', projectId: 'p1', summary: 'legacy', relativeTime: 'now',
    messages: [
      { id: 'u1', role: 'user', content: 'check file' },
      { id: 'a1', role: 'agent', content: 'checked file' }
    ]
  })
  const ledger = new ModelLedgerStore(path.join(root, 'session-runtime'))
  return {
    root,
    summarize,
    sessions,
    ledger,
    service: new LegacySessionMigrationService(sessions, ledger, { summarize })
  }
}

describe('LegacySessionMigrationService', () => {
  it('summarizes a plain transcript without fabricating tool protocol', async () => {
    const f = await fixture()
    const result = await f.service.ensureMigrated('s1')
    expect(f.summarize.mock.calls[0][0].transcript).toContain('User: check file')
    expect(f.summarize.mock.calls[0][0].transcript).toContain('Agent: checked file')
    expect(f.summarize.mock.calls[0][0].transcript).not.toContain('tool_call_id')
    expect(result.mode).toBe('summary')
    expect(f.sessions.get('s1')?.runtime?.schemaVersion).toBe(2)
  })

  it('falls back to bounded recent text and remains idempotent', async () => {
    const summarize = vi.fn().mockRejectedValue(new Error('offline'))
    const f = await fixture(summarize)
    const first = await f.service.ensureMigrated('s1')
    const second = await f.service.ensureMigrated('s1')
    expect(first.mode).toBe('recent-text-fallback')
    expect(second.sourceHash).toBe(first.sourceHash)
    expect(summarize).toHaveBeenCalledTimes(1)
    expect((await f.ledger.load('s1')).scopes.main.activeMessages.every((message) => message.role !== 'tool')).toBe(true)
  })

  it('recovers a missing runtime reference from a completed ledger import', async () => {
    const f = await fixture()
    const first = await f.service.ensureMigrated('s1')
    const recoveryFile = path.join(f.root, 'recovery-sessions.json')
    const recoverySessions = new SessionStore(recoveryFile)
    await recoverySessions.save({
      id: 's1', projectId: 'p1', summary: 'legacy', relativeTime: 'now',
      messages: [
        { id: 'u1', role: 'user', content: 'check file' },
        { id: 'a1', role: 'agent', content: 'checked file' },
        { id: 'a2', role: 'agent', content: 'renderer persisted a terminal error' }
      ]
    })

    const recovered = await new LegacySessionMigrationService(
      recoverySessions,
      f.ledger,
      { summarize: f.summarize }
    ).ensureMigrated('s1')

    expect(recovered).toEqual(first)
    expect(f.summarize).toHaveBeenCalledTimes(1)
    expect(recoverySessions.get('s1')?.runtime).toMatchObject({
      legacySourceHash: first.sourceHash,
      legacyImportMode: first.mode
    })
  })
})
