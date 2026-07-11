import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { AgentRunner, unwrapModelToolResultForUi } from '../main/agent/AgentRunner'
import { ModelLedgerStore } from '../main/services/context/ModelLedgerStore'
import { SessionRuntimeCoordinator } from '../main/services/context/SessionRuntimeCoordinator'
import { ModelContextBuilder } from '../main/services/context/ModelContextBuilder'
import type { ContextBudgetSnapshot } from '../shared/types/context'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('AgentRunner canonical ledger path', () => {
  it('keeps model wrappers out of the UI tool result boundary', () => {
    expect(unwrapModelToolResultForUi(JSON.stringify({ ok: true, data: 'raw result' }))).toBe('raw result')
    expect(unwrapModelToolResultForUi(JSON.stringify({
      ok: false, error: { code: 'FAILED', message: 'readable failure' }
    }))).toBe('readable failure')
  })

  it('persists model and tool protocol before completing the UI lifecycle', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-runner-ledger-'))
    dirs.push(root)
    const ledger = new ModelLedgerStore(path.join(root, 'runtime'))
    const runtime = new SessionRuntimeCoordinator(ledger)
    const turn = await runtime.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: 'list tasks', providerId: 'p1', model: 'm1'
    })
    const builder = new ModelContextBuilder(ledger)
    const order: string[] = []
    const budgets: ContextBudgetSnapshot[] = []
    const originalRecord = runtime.recordToolResult.bind(runtime)
    vi.spyOn(runtime, 'recordToolResult').mockImplementation(async (...args) => {
      order.push('persist-tool')
      return originalRecord(...args)
    })

    let sample = 0
    const chatService = {
      streamChat: vi.fn(async (_config: unknown, callbacks: any) => {
        sample++
        if (sample === 1) {
          callbacks.onChunk('', '', [{ index: 0, id: 'c1', function: { name: 'TaskList', arguments: '{}' } }])
          callbacks.onDone('', 'tool_calls')
        } else {
          callbacks.onChunk('done', '')
          callbacks.onUsage?.({ inputTokens: 100, outputTokens: 5, totalTokens: 105 })
          callbacks.onDone('done', 'stop')
        }
      }),
      abort: vi.fn()
    }
    const toolManager = {
      getToolDefinitions: () => [],
      getTool: () => ({ execute: async () => 'task result' })
    }
    const transaction = {
      beginTransaction: async () => 'tx1',
      rollback: async () => undefined
    }
    const runner = new AgentRunner({
      chatService: chatService as any,
      toolManager: toolManager as any,
      editTransactionService: transaction as any
    })

    await runner.run({
      baseUrl: 'https://example.test', apiKey: 'key', model: 'm1', workspaceRoot: root,
      tools: [{ type: 'function', function: { name: 'TaskList', description: 'list', parameters: { type: 'object' } } }],
      providerId: 'p1', runtimeTurn: turn, runtimeCoordinator: runtime, contextBuilder: builder,
      contextCapabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system'
    }, {
      onChunk: () => undefined,
      onDone: () => order.push('ui-done'),
      onError: (error) => { throw new Error(error) },
      onToolEnd: () => order.push('ui-tool-end'),
      onContextBudget: (budget) => budgets.push(budget)
    })

    const scope = (await ledger.load('s1')).scopes.main
    expect(scope.activeMessages.map((message) => message.role)).toEqual([
      'user', 'assistant', 'tool', 'assistant'
    ])
    expect(scope.lastCompletedTurnId).toBe(turn.turnId)
    expect(order.indexOf('persist-tool')).toBeLessThan(order.indexOf('ui-tool-end'))
    expect(order.at(-1)).toBe('ui-done')
    expect(budgets.at(-1)?.estimateSource).toBe('provider')
    expect(budgets.at(-1)?.totalInputTokens).toBe(100)
  })
})
