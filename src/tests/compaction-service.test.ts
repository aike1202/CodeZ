import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { ModelLedgerStore } from '../main/services/context/ModelLedgerStore'
import { SessionRuntimeCoordinator } from '../main/services/context/SessionRuntimeCoordinator'
import { CompactionService } from '../main/services/context/CompactionService'
import type { CompactionSummaryV1 } from '../shared/types/context'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

function summary(sequence: number): CompactionSummaryV1 {
  return {
    version: 1,
    goal: { currentObjective: 'continue', requirements: [], successCriteria: [] },
    status: { phase: 'work', completed: [], inProgress: [], nextActions: [] },
    decisions: [], facts: [], files: [], validation: [], errors: [],
    openQuestions: [], userInstructions: [], coveredThroughSequence: sequence
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codez-compact-'))
  dirs.push(root)
  const ledger = new ModelLedgerStore(root)
  const runtime = new SessionRuntimeCoordinator(ledger)
  for (let index = 0; index < 5; index++) {
    const turn = await runtime.beginTurn({ sessionId: 's1', contextScopeId: 'main', text: `question ${index} ${'Q'.repeat(2000)}` })
    await runtime.recordAssistant(turn, { content: `answer ${index} ${'A'.repeat(2000)}` })
    await runtime.completeTurn(turn, { stopReason: 'stop' })
  }
  return { root, ledger, runtime }
}

describe('CompactionService', () => {
  it('commits a validated summary and retained tail', async () => {
    const f = await fixture()
    const model = { generate: async (input: { coveredThroughSequence: number }) => JSON.stringify(summary(input.coveredThroughSequence)) }
    const service = new CompactionService(f.ledger, model)
    const result = await service.compact({
      sessionId: 's1', contextScopeId: 'main', trigger: 'manual',
      capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system'
    })
    expect(result.status).toBe('completed')
    const scope = (await f.ledger.load('s1')).scopes.main
    expect(scope.latestCompaction?.version).toBe(1)
    expect(scope.activeMessages.length).toBeLessThan(10)
  })

  it('retries once when the source version changes during generation', async () => {
    const f = await fixture()
    let calls = 0
    const model = {
      generate: async (input: { coveredThroughSequence: number }) => {
        calls++
        if (calls === 1) {
          await f.ledger.append('s1', 'main', 'user_message', {
            message: {
              id: 'concurrent', turnId: 'concurrent', role: 'user', content: 'new',
              status: 'complete', createdAt: new Date().toISOString()
            }
          }, 'concurrent')
        }
        return JSON.stringify(summary(input.coveredThroughSequence))
      }
    }
    const result = await new CompactionService(f.ledger, model).compact({
      sessionId: 's1', contextScopeId: 'main', trigger: 'manual',
      capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 }, systemPrompt: 'system'
    })
    expect(result.status).toBe('completed')
    expect(calls).toBe(2)
  })

  it('keeps the logical commit when snapshot persistence is deferred', async () => {
    const f = await fixture()
    const model = { generate: async (input: { coveredThroughSequence: number }) => JSON.stringify(summary(input.coveredThroughSequence)) }
    const rotate = vi.spyOn(f.ledger, 'compactPhysicalLog')
    vi.spyOn(f.ledger, 'writeSnapshot').mockRejectedValueOnce(new Error('disk unavailable'))
    const result = await new CompactionService(f.ledger, model).compact({
      sessionId: 's1', contextScopeId: 'main', trigger: 'manual',
      capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 }, systemPrompt: 'system'
    })
    expect(result).toMatchObject({ status: 'completed', snapshotStatus: 'deferred' })
    expect(rotate).not.toHaveBeenCalled()
    const reloaded = await new ModelLedgerStore(f.root).load('s1')
    expect(reloaded.scopes.main.latestCompaction?.version).toBe(1)
  })

  it('stops after three insufficient-reduction attempts', async () => {
    const f = await fixture()
    let calls = 0
    const model = {
      generate: async (input: { coveredThroughSequence: number }) => {
        calls++
        const oversized = summary(input.coveredThroughSequence)
        oversized.facts = Array.from({ length: 180 }, (_, index) => ({
          fact: `${index}:${'X'.repeat(120)}`
        }))
        return JSON.stringify(oversized)
      }
    }
    const result = await new CompactionService(f.ledger, model).compact({
      sessionId: 's1', contextScopeId: 'main', trigger: 'manual',
      capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 }, systemPrompt: 'system'
    })
    expect(result).toMatchObject({
      status: 'failed', errorCode: 'COMPACTION_INSUFFICIENT_REDUCTION'
    })
    expect(calls).toBe(3)
  })
})
