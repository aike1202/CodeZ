import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { ModelLedgerStore } from '../main/services/context/ModelLedgerStore'
import { SessionRuntimeCoordinator } from '../main/services/context/SessionRuntimeCoordinator'
import { CompactionService } from '../main/services/context/CompactionService'
import { ContextBudgetService } from '../main/services/context/ContextBudgetService'
import { ModelContextBuilder } from '../main/services/context/ModelContextBuilder'
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

  it('retries when history changes during post-summary file restoration', async () => {
    const f = await fixture()
    let restoreCalls = 0
    const restorer = {
      restore: vi.fn(async () => {
        restoreCalls++
        if (restoreCalls === 1) {
          await f.ledger.append('s1', 'main', 'user_message', {
            message: {
              id: 'late-user', turnId: 'late-turn', role: 'user', content: 'late input',
              status: 'complete', createdAt: new Date().toISOString()
            }
          }, 'late-turn')
        }
        return undefined
      })
    }
    const generate = vi.fn(async (input: { coveredThroughSequence: number }) =>
      JSON.stringify(summary(input.coveredThroughSequence)))
    const service = new CompactionService(
      f.ledger,
      { generate },
      undefined,
      undefined,
      restorer as any
    )

    const result = await service.compact({
      sessionId: 's1', contextScopeId: 'main', trigger: 'manual',
      capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system', workspaceRoot: f.root
    })

    expect(result.status).toBe('completed')
    expect(generate).toHaveBeenCalledTimes(2)
    expect((await f.ledger.load('s1')).scopes.main.activeMessages)
      .toContainEqual(expect.objectContaining({ id: 'late-user' }))
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

  it('allows a later compact request to retry after invalid schema responses', async () => {
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
    expect(second).toMatchObject({ status: 'failed', errorCode: 'COMPACTION_SCHEMA_INVALID' })
    expect(generate).toHaveBeenCalledTimes(4)
    const events = (await readFile(f.ledger.ledgerPath('s1'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(events.filter((event) => event.type === 'compaction_failed'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ payload: expect.objectContaining({ retryable: true }) })
      ]))
  })

  it('compacts an oversized active turn repeatedly while retaining its durable user input', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-compact-active-turn-'))
    dirs.push(root)
    const ledger = new ModelLedgerStore(root)
    const runtime = new SessionRuntimeCoordinator(ledger)
    const turn = await runtime.beginTurn({
      sessionId: 'active', contextScopeId: 'main', text: 'finish one long task'
    })
    let callIndex = 0
    const addGroups = async (count: number) => {
      for (let index = 0; index < count; index++) {
        const callId = `call-${callIndex++}`
        await runtime.recordAssistant(turn, {
          content: '', toolCalls: [{ id: callId, name: 'Read', arguments: '{}' }]
        })
        await runtime.recordToolResult(turn, {
          callId,
          name: 'Read',
          content: JSON.stringify({ ok: true, data: 'T'.repeat(5_000) }),
          status: 'success'
        })
      }
    }
    await addGroups(8)
    const service = new CompactionService(ledger, {
      generate: async (input) => JSON.stringify(summary(input.coveredThroughSequence))
    })
    const request = {
      sessionId: 'active', contextScopeId: 'main' as const, trigger: 'manual' as const,
      capabilities: { contextWindowTokens: 6_000, maxOutputTokens: 1_000 },
      systemPrompt: 'system', requiredMessageId: turn.userMessageId
    }

    expect((await service.compact(request)).status).toBe('completed')
    expect((await ledger.load('active')).scopes.main.activeMessages)
      .toContainEqual(expect.objectContaining({ id: turn.userMessageId }))

    await addGroups(5)
    expect((await service.compact(request)).status).toBe('completed')
    const built = await new ModelContextBuilder(ledger).build({
      sessionId: 'active', contextScopeId: 'main',
      currentInputMessageId: turn.userMessageId,
      currentInput: turn.inputText,
      capabilities: request.capabilities,
      systemPrompt: 'system', toolSchemas: [], allowCompaction: false
    })
    expect(built.messages).toContainEqual(expect.objectContaining({
      role: 'user', content: 'finish one long task'
    }))
  })

  it('uses the effective reasoning reserve for compaction limits', async () => {
    const f = await fixture()
    const budget = new ContextBudgetService()
    const resolveLimits = vi.spyOn(budget, 'resolveLimits')
    const service = new CompactionService(f.ledger, {
      generate: async (input) => JSON.stringify(summary(input.coveredThroughSequence))
    }, budget)
    const capabilities = {
      contextWindowTokens: 10_000,
      maxOutputTokens: 2_000,
      reasoningCountsAgainstContext: true
    }

    await service.compact({
      sessionId: 's1', contextScopeId: 'main', trigger: 'manual',
      capabilities, systemPrompt: 'system', reasoningBudgetTokens: 1_234
    })

    expect(resolveLimits).toHaveBeenCalledWith(capabilities, 1_234)
  })

  it('deduplicates repeated Read bodies before calling the compaction model', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-compact-read-dedup-'))
    dirs.push(root)
    const ledger = new ModelLedgerStore(root)
    const runtime = new SessionRuntimeCoordinator(ledger)
    const filePath = path.join(root, 'active.ts')
    const readBody = `READ_BODY_MARKER_${'R'.repeat(2_000)}`
    for (let index = 0; index < 2; index++) {
      const turn = await runtime.beginTurn({
        sessionId: 's1', contextScopeId: 'main', text: `read ${index}`
      })
      await runtime.recordAssistant(turn, {
        content: '', toolCalls: [{ id: `read-${index}`, name: 'Read', arguments: '{}' }]
      })
      await runtime.recordToolResult(turn, {
        callId: `read-${index}`,
        name: 'Read',
        content: JSON.stringify({ ok: true, data: `<file path="active.ts">\n${readBody}\n</file>` }),
        status: 'success',
        fileReferences: [{
          path: filePath, sha256: 'same-file', operation: 'read', contentIncluded: true,
          contentSha256: 'same-range', offset: 1, limit: 100
        }]
      })
      await runtime.completeTurn(turn, { stopReason: 'tool_calls' })
    }
    for (let index = 0; index < 6; index++) {
      const turn = await runtime.beginTurn({
        sessionId: 's1', contextScopeId: 'main', text: `later ${index} ${'Q'.repeat(2_000)}`
      })
      await runtime.recordAssistant(turn, { content: `answer ${'A'.repeat(2_000)}` })
      await runtime.completeTurn(turn, { stopReason: 'stop' })
    }

    const generate = vi.fn(async (input: {
      coveredThroughSequence: number
      messages: Array<{ content: string }>
    }) => JSON.stringify(summary(input.coveredThroughSequence)))
    const result = await new CompactionService(ledger, { generate }).compact({
      sessionId: 's1', contextScopeId: 'main', trigger: 'manual',
      capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 }, systemPrompt: 'system'
    })

    expect(result.status).toBe('completed')
    const compactMessages = generate.mock.calls[0][0].messages
    const serialized = compactMessages.map((message) => message.content).join('\n')
    expect(serialized.match(/READ_BODY_MARKER/g)).toHaveLength(1)
    const readTokenSizes = compactMessages
      .filter((message: any) => message.name === 'Read')
      .map((message) => JSON.parse(message.content).originalTokensEstimate as number)
    expect(readTokenSizes.some((tokens) => tokens < 100)).toBe(true)
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
