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

  it('repairs one invalid schema response and then commits', async () => {
    const f = await fixture()
    let calls = 0
    const generate = vi.fn(async (input: {
      coveredThroughSequence: number
      validationFeedback?: string
    }) => {
      calls++
      return calls === 1
        ? JSON.stringify({ version: '1', goal: 'continue' })
        : JSON.stringify(summary(input.coveredThroughSequence))
    })
    const result = await new CompactionService(f.ledger, { generate }).compact({
      sessionId: 's1', contextScopeId: 'main', trigger: 'manual',
      capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 }, systemPrompt: 'system'
    })
    expect(result.status).toBe('completed')
    expect(generate).toHaveBeenCalledTimes(2)
    expect(generate.mock.calls[1][0].validationFeedback).toContain('version must be 1')
  })

  it('opens a circuit after two invalid schema responses', async () => {
    const f = await fixture()
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ version: '1', goal: 'continue' }))
    const service = new CompactionService(f.ledger, { generate })
    const request = {
      sessionId: 's1', contextScopeId: 'main' as const, trigger: 'manual' as const,
      capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 }, systemPrompt: 'system'
    }
    const first = await service.compact(request)
    const second = await service.compact(request)
    expect(first).toMatchObject({ status: 'failed', errorCode: 'COMPACTION_SCHEMA_INVALID' })
    expect(second).toEqual(first)
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('bounds oversized tool output before sending the compaction request', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-compact-huge-tool-'))
    dirs.push(root)
    const ledger = new ModelLedgerStore(root)
    const runtime = new SessionRuntimeCoordinator(ledger)
    const toolTurn = await runtime.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: 'list every file'
    })
    await runtime.recordAssistant(toolTurn, {
      content: '',
      toolCalls: [{ id: 'glob-1', name: 'Glob', arguments: '{"pattern":"**/*"}' }]
    })
    await runtime.recordToolResult(toolTurn, {
      callId: 'glob-1', name: 'Glob', content: 'G'.repeat(621_396), status: 'success'
    })
    await runtime.completeTurn(toolTurn, { stopReason: 'tool_calls' })
    for (let index = 0; index < 5; index++) {
      const turn = await runtime.beginTurn({
        sessionId: 's1', contextScopeId: 'main', text: `question ${index} ${'Q'.repeat(2000)}`
      })
      await runtime.recordAssistant(turn, { content: `answer ${index} ${'A'.repeat(2000)}` })
      await runtime.completeTurn(turn, { stopReason: 'stop' })
    }

    const generate = vi.fn(async (input: {
      coveredThroughSequence: number
      messages: Array<{ role: string; content: string }>
    }) => JSON.stringify(summary(input.coveredThroughSequence)))
    const result = await new CompactionService(ledger, { generate }).compact({
      sessionId: 's1', contextScopeId: 'main', trigger: 'manual',
      capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 }, systemPrompt: 'system'
    })

    expect(result.status).toBe('completed')
    const compactionMessages = generate.mock.calls[0][0].messages
    const toolResult = compactionMessages.find((message) => message.role === 'tool')
    expect(toolResult?.content).toContain('TOOL_OUTPUT_PRUNED')
    expect(toolResult?.content.length).toBeLessThan(10_000)
  })
})
