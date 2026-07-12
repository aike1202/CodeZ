import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { AgentRunner } from '../main/agent/AgentRunner'
import { ModelContextBuilder } from '../main/services/context/ModelContextBuilder'
import { ModelLedgerStore } from '../main/services/context/ModelLedgerStore'
import { SessionRuntimeCoordinator } from '../main/services/context/SessionRuntimeCoordinator'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codez-overflow-'))
  dirs.push(root)
  const ledger = new ModelLedgerStore(path.join(root, 'runtime'))
  const coordinator = new SessionRuntimeCoordinator(ledger)
  const turn = await coordinator.beginTurn({
    sessionId: 's1', contextScopeId: 'main', text: 'continue'
  })
  return { root, ledger, coordinator, turn, builder: new ModelContextBuilder(ledger) }
}

describe('AgentRunner provider overflow recovery', () => {
  it('compacts and retries one time without exposing the recovered overflow', async () => {
    const f = await fixture()
    let samples = 0
    const chatService = {
      streamChat: vi.fn(async (_config: unknown, callbacks: any) => {
        samples++
        if (samples === 1) callbacks.onError('too many tokens', 'CONTEXT_OVERFLOW')
        else {
          callbacks.onChunk('done', '')
          callbacks.onDone('done', 'stop')
        }
      }),
      abort: vi.fn()
    }
    const compact = vi.fn().mockResolvedValue({ status: 'completed' })
    const onError = vi.fn()
    const runner = new AgentRunner({
      chatService: chatService as any,
      toolManager: { getToolDefinitions: () => [] } as any,
      editTransactionService: {
        beginTransaction: async () => 'tx1', rollback: vi.fn()
      } as any
    })

    await runner.run({
      baseUrl: 'https://example.invalid', apiKey: 'key', apiFormat: 'anthropic',
      model: 'claude-3-7-sonnet', workspaceRoot: f.root,
      thinking: { enabled: true, mode: 'anthropic', effort: 'custom', budgetTokens: 1 },
      runtimeTurn: f.turn, runtimeCoordinator: f.coordinator, contextBuilder: f.builder,
      compactionService: { compact } as any,
      contextCapabilities: {
        contextWindowTokens: 10_000,
        maxOutputTokens: 2_000,
        reasoningCountsAgainstContext: true
      },
      systemPrompt: 'system'
    }, { onChunk: vi.fn(), onDone: vi.fn(), onError })

    expect(chatService.streamChat).toHaveBeenCalledTimes(2)
    expect(compact).toHaveBeenCalledTimes(1)
    expect(compact).toHaveBeenCalledWith(expect.objectContaining({
      trigger: 'provider_overflow',
      reasoningBudgetTokens: 1024
    }))
    expect(onError).not.toHaveBeenCalled()
    expect((await f.ledger.load('s1')).scopes.main.lastCompletedTurnId).toBe(f.turn.turnId)
  })

  it('reports and interrupts when the retried request also overflows', async () => {
    const f = await fixture()
    const chatService = {
      streamChat: vi.fn(async (_config: unknown, callbacks: any) => {
        callbacks.onError('still too many tokens', 'CONTEXT_OVERFLOW')
      }),
      abort: vi.fn()
    }
    const compact = vi.fn().mockResolvedValue({ status: 'completed' })
    const onError = vi.fn()
    const runner = new AgentRunner({
      chatService: chatService as any,
      toolManager: { getToolDefinitions: () => [] } as any,
      editTransactionService: {
        beginTransaction: async () => 'tx1', rollback: vi.fn()
      } as any
    })

    await runner.run({
      baseUrl: 'https://example.invalid', apiKey: 'key', model: 'm1', workspaceRoot: f.root,
      runtimeTurn: f.turn, runtimeCoordinator: f.coordinator, contextBuilder: f.builder,
      compactionService: { compact } as any,
      contextCapabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system'
    }, { onChunk: vi.fn(), onDone: vi.fn(), onError })

    expect(chatService.streamChat).toHaveBeenCalledTimes(2)
    expect(compact).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('still too many tokens', 'CONTEXT_OVERFLOW')
    expect((await f.ledger.load('s1')).scopes.main.lastInterruptedTurnId).toBe(f.turn.turnId)
  })
})
