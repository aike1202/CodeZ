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

  it('converts a degraded text clarification to an AskUserQuestion tool call', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-runner-text-ask-'))
    dirs.push(root)
    const ledger = new ModelLedgerStore(path.join(root, 'runtime'))
    const runtime = new SessionRuntimeCoordinator(ledger)
    const turn = await runtime.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: 'build a todo app', providerId: 'p1', model: 'm1'
    })
    const rawQuestion = JSON.stringify({
      question: '首期要支持哪些平台？',
      options: ['Windows 10/11', 'Windows + macOS']
    })
    let sample = 0
    const chatService = {
      streamChat: vi.fn(async (_config: unknown, callbacks: any) => {
        sample++
        if (sample === 1) {
          callbacks.onChunk(rawQuestion, '')
          callbacks.onDone(rawQuestion, 'stop')
        } else {
          callbacks.onChunk('继续执行', '')
          callbacks.onDone('继续执行', 'stop')
        }
      }),
      abort: vi.fn()
    }
    const runner = new AgentRunner({
      chatService: chatService as any,
      toolManager: {
        getToolDefinitions: () => [],
        getTool: () => ({ execute: async () => 'unexpected execution' })
      } as any,
      editTransactionService: { beginTransaction: async () => 'tx1', rollback: async () => undefined } as any
    })
    const started: Array<{ name: string; args: string; fallback?: boolean }> = []
    const requests: any[] = []

    await runner.run({
      baseUrl: 'https://example.test', apiKey: 'key', model: 'm1', workspaceRoot: root,
      tools: [{ type: 'function', function: { name: 'AskUserQuestion', description: 'ask', parameters: { type: 'object' } } }],
      providerId: 'p1', runtimeTurn: turn, runtimeCoordinator: runtime, contextBuilder: new ModelContextBuilder(ledger),
      contextCapabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system'
    }, {
      onChunk: () => undefined,
      onDone: () => undefined,
      onError: (error) => { throw new Error(error) },
      onToolStart: (_id, name, args, _signature, meta) => {
        started.push({ name, args, fallback: meta?.textAskUserFallback })
      },
      onAskUserRequest: async (request) => {
        requests.push(request)
        return [{ question: request.questions[0].question, answer: 'Windows 10/11' }]
      }
    })

    const scope = (await ledger.load('s1')).scopes.main
    expect(scope.activeMessages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(scope.activeMessages[1].content).toBe('')
    expect(started).toEqual([{
      name: 'AskUserQuestion',
      args: JSON.stringify({
        questions: [{
          question: '首期要支持哪些平台？',
          header: '需要确认',
          options: [{ label: 'Windows 10/11' }, { label: 'Windows + macOS' }]
        }]
      }),
      fallback: true
    }])
    expect(requests).toHaveLength(1)
    expect(requests[0].questions[0].options).toEqual([{ label: 'Windows 10/11' }, { label: 'Windows + macOS' }])

    const secondRequest = chatService.streamChat.mock.calls[1][0] as {
      messages: Array<{ role: string; name?: string; content: string }>
    }
    const lastMessage = secondRequest.messages.at(-1)
    expect(lastMessage).toMatchObject({ role: 'tool', name: 'AskUserQuestion' })
    expect(lastMessage?.content).toContain('Windows 10/11')
  })
})
