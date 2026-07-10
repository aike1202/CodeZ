import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { ModelHistoryNormalizer } from '../main/services/context/ModelHistoryNormalizer'
import { ModelLedgerStore } from '../main/services/context/ModelLedgerStore'
import { SessionRuntimeCoordinator } from '../main/services/context/SessionRuntimeCoordinator'
import type { CompactionSummaryV1 } from '../shared/types/context'

type CrashPoint =
  | 'after-user'
  | 'after-assistant-tool-call'
  | 'after-one-of-two-tool-results'
  | 'after-compaction-completed'
  | 'after-snapshot-before-rotation'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function summary(coveredThroughSequence: number): CompactionSummaryV1 {
  return {
    version: 1,
    goal: { currentObjective: 'continue safely', requirements: [], successCriteria: [] },
    status: { phase: 'work', completed: [], inProgress: [], nextActions: [] },
    decisions: [], facts: [], files: [], validation: [], errors: [],
    openQuestions: [], userInstructions: [], coveredThroughSequence
  }
}

async function crashAt(point: CrashPoint): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codez-crash-matrix-'))
  dirs.push(root)
  const ledger = new ModelLedgerStore(root)
  const coordinator = new SessionRuntimeCoordinator(ledger)
  const turn = await coordinator.beginTurn({
    sessionId: 's1', contextScopeId: 'main', text: 'continue'
  })

  if (point === 'after-user') return root

  if (point === 'after-assistant-tool-call' || point === 'after-one-of-two-tool-results') {
    await coordinator.recordAssistant(turn, {
      content: '',
      toolCalls: [
        { id: 'c1', name: 'Read', arguments: '{"path":"a.ts"}' },
        { id: 'c2', name: 'Read', arguments: '{"path":"b.ts"}' }
      ]
    })
    if (point === 'after-one-of-two-tool-results') {
      await coordinator.recordToolResult(turn, {
        callId: 'c1', name: 'Read', content: '{"ok":true,"data":"a"}', status: 'success'
      })
    }
    return root
  }

  await coordinator.recordAssistant(turn, { content: 'completed answer' })
  await coordinator.completeTurn(turn, { stopReason: 'stop' })
  const before = await ledger.load('s1')
  const activeMessages = before.scopes.main.activeMessages
  const coveredThroughSequence = activeMessages.at(-1)?.sourceSequence || before.throughSequence
  await ledger.append('s1', 'main', 'compaction_completed', {
    trigger: 'manual',
    sourceHistoryVersion: before.scopes.main.historyVersion,
    coveredThroughSequence,
    tokensBefore: 100,
    tokensAfter: 40,
    sourceHash: 'fixture',
    summary: summary(coveredThroughSequence),
    activeMessages
  })
  if (point === 'after-snapshot-before-rotation') await ledger.writeSnapshot('s1')
  return root
}

describe('context crash recovery matrix', () => {
  it.each<CrashPoint>([
    'after-user',
    'after-assistant-tool-call',
    'after-one-of-two-tool-results',
    'after-compaction-completed',
    'after-snapshot-before-rotation'
  ])('recovers %s to an invariant and remains idempotent', async (point) => {
    const root = await crashAt(point)
    const firstLedger = new ModelLedgerStore(root)
    await new SessionRuntimeCoordinator(firstLedger).recoverSession('s1')
    const first = (await firstLedger.load('s1')).scopes.main
    expect(() => ModelHistoryNormalizer.assertProtocolInvariant(first.activeMessages)).not.toThrow()

    const secondLedger = new ModelLedgerStore(root)
    const secondRecovery = await new SessionRuntimeCoordinator(secondLedger).recoverSession('s1')
    const second = (await secondLedger.load('s1')).scopes.main
    expect(secondRecovery.recoveredScopes).toEqual([])
    expect(second.activeMessages).toEqual(first.activeMessages)
    expect(second.historyVersion).toBe(first.historyVersion)
  })
})
