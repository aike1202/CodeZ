import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { AgentRunner, unwrapModelToolResultForUi } from '../main/agent/AgentRunner'
import { ModelLedgerStore } from '../main/services/context/ModelLedgerStore'
import { SessionRuntimeCoordinator } from '../main/services/context/SessionRuntimeCoordinator'
import { ModelContextBuilder } from '../main/services/context/ModelContextBuilder'
import { TaskStore } from '../main/services/TaskStore'
import type { ContextBudgetSnapshot } from '../shared/types/context'

const dirs: string[] = []
const taskSessions: string[] = []
afterEach(async () => {
  delete process.env.CODEZ_TOOL_RUNTIME_V2
  for (const sessionId of taskSessions.splice(0)) TaskStore.getInstance().restore(sessionId, [])
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('AgentRunner canonical ledger path', () => {
  it('keeps model wrappers out of the UI tool result boundary', () => {
    expect(unwrapModelToolResultForUi(JSON.stringify({ ok: true, data: 'raw result' }))).toBe('raw result')
    expect(unwrapModelToolResultForUi(JSON.stringify({
      ok: false, error: { code: 'FAILED', message: 'readable failure' }
    }))).toBe('readable failure')
  })

  it.each([
    ['V2 runtime', '1'],
    ['legacy rollback runtime', '0']
  ])('persists model and tool protocol before completing the UI lifecycle with %s', async (_label, runtimeFlag) => {
    process.env.CODEZ_TOOL_RUNTIME_V2 = runtimeFlag
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
    expect(scope.lastProviderUsageRequestFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(order.indexOf('persist-tool')).toBeLessThan(order.indexOf('ui-tool-end'))
    expect(order.at(-1)).toBe('ui-done')
    expect(budgets.at(-1)?.estimateSource).toBe('provider')
    expect(budgets.at(-1)?.totalInputTokens).toBe(100)
  })

  it('keeps executing tools after loop 30 while the run is making progress', async () => {
    process.env.CODEZ_TOOL_RUNTIME_V2 = '0'
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-runner-unbounded-'))
    dirs.push(root)
    const ledger = new ModelLedgerStore(path.join(root, 'runtime'))
    const runtime = new SessionRuntimeCoordinator(ledger)
    const turn = await runtime.beginTurn({
      sessionId: 'unbounded-s1', contextScopeId: 'main', text: 'inspect repeatedly', providerId: 'p1', model: 'm1'
    })
    let sample = 0
    const chatService = {
      streamChat: vi.fn(async (_config: unknown, callbacks: any) => {
        sample++
        if (sample <= 31) {
          callbacks.onChunk('', '', [{
            index: 0,
            id: `call-${sample}`,
            function: { name: 'TaskList', arguments: '{}' }
          }])
          callbacks.onDone('', 'tool_calls')
        } else {
          callbacks.onChunk('done after 31 tool rounds', '')
          callbacks.onDone('done after 31 tool rounds', 'stop')
        }
      }),
      abort: vi.fn()
    }
    const rollback = vi.fn(async () => undefined)
    const runner = new AgentRunner({
      chatService: chatService as any,
      toolManager: {
        getToolDefinitions: () => [],
        getTool: () => ({ execute: async () => 'unexpected fallback execution' })
      } as any,
      editTransactionService: {
        beginTransaction: async () => 'tx-unbounded',
        rollback
      } as any
    })
    const toolEnds: string[] = []
    const onDone = vi.fn()

    await runner.run({
      baseUrl: 'https://example.test', apiKey: 'key', model: 'm1', workspaceRoot: root,
      tools: [{ type: 'function', function: { name: 'TaskList', description: 'list', parameters: { type: 'object' } } }],
      providerId: 'p1', runtimeTurn: turn, runtimeCoordinator: runtime,
      contextBuilder: new ModelContextBuilder(ledger),
      contextCapabilities: { contextWindowTokens: 100_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system'
    }, {
      onChunk: () => undefined,
      onDone,
      onError: (error) => { throw new Error(error) },
      onToolEnd: (callId) => toolEnds.push(callId)
    })

    expect(chatService.streamChat).toHaveBeenCalledTimes(32)
    expect(toolEnds).toHaveLength(31)
    expect(toolEnds.at(-1)).toBe('call-31')
    expect(onDone).toHaveBeenCalledWith('done after 31 tool rounds', 'stop', 'tx-unbounded')
    expect(rollback).not.toHaveBeenCalled()
    expect((await ledger.load('unbounded-s1')).scopes.main.lastCompletedTurnId).toBe(turn.turnId)
  })

  it('pauses instead of looping after repeated tool failures', async () => {
    process.env.CODEZ_TOOL_RUNTIME_V2 = '0'
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-runner-failure-limit-'))
    dirs.push(root)
    const ledger = new ModelLedgerStore(path.join(root, 'runtime'))
    const runtime = new SessionRuntimeCoordinator(ledger)
    const turn = await runtime.beginTurn({
      sessionId: 'failure-s1', contextScopeId: 'main', text: 'keep retrying', providerId: 'p1', model: 'm1'
    })
    let sample = 0
    const chatService = {
      streamChat: vi.fn(async (_config: unknown, callbacks: any) => {
        sample++
        callbacks.onChunk('', '', [{
          index: 0,
          id: `failure-call-${sample}`,
          function: { name: 'MissingTool', arguments: '{}' }
        }])
        callbacks.onDone('', 'tool_calls')
      }),
      abort: vi.fn()
    }
    const rollback = vi.fn(async () => undefined)
    const runner = new AgentRunner({
      chatService: chatService as any,
      toolManager: { getToolDefinitions: () => [] } as any,
      editTransactionService: {
        beginTransaction: async () => 'tx-failure-limit',
        rollback
      } as any
    })
    const toolResults: string[] = []
    const onDone = vi.fn()

    await runner.run({
      baseUrl: 'https://example.test', apiKey: 'key', model: 'm1', workspaceRoot: root,
      tools: [{ type: 'function', function: { name: 'MissingTool', description: 'missing', parameters: { type: 'object' } } }],
      providerId: 'p1', runtimeTurn: turn, runtimeCoordinator: runtime,
      contextBuilder: new ModelContextBuilder(ledger),
      contextCapabilities: { contextWindowTokens: 20_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system'
    }, {
      onChunk: () => undefined,
      onDone,
      onError: (error) => { throw new Error(error) },
      onToolEnd: (_callId, result) => toolResults.push(result)
    })

    expect(chatService.streamChat).toHaveBeenCalledTimes(6)
    expect(toolResults).toHaveLength(6)
    expect(toolResults.at(-1)).toContain('已连续失败 5 次')
    expect(onDone).toHaveBeenCalledWith('', 'tool_calls', 'tx-failure-limit')
    expect(rollback).not.toHaveBeenCalled()
    expect((await ledger.load('failure-s1')).scopes.main.lastCompletedTurnId).toBe(turn.turnId)
  })

  it('pauses after three unchanged text-only turns with active tasks', async () => {
    const sessionId = 'idle-s1'
    taskSessions.push(sessionId)
    TaskStore.getInstance().restore(sessionId, [{
      id: 't1',
      subject: 'Finish implementation',
      description: '',
      status: 'in_progress'
    }])
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-runner-idle-'))
    dirs.push(root)
    const ledger = new ModelLedgerStore(path.join(root, 'runtime'))
    const runtime = new SessionRuntimeCoordinator(ledger)
    const continuationSpy = vi.spyOn(runtime, 'recordUserContinuation')
    const turn = await runtime.beginTurn({
      sessionId, contextScopeId: 'main', text: 'finish the task', providerId: 'p1', model: 'm1'
    })
    let sample = 0
    const chatService = {
      streamChat: vi.fn(async (_config: unknown, callbacks: any) => {
        sample++
        const content = `progress update ${sample}`
        callbacks.onChunk(content, '')
        callbacks.onDone(content, 'stop')
      }),
      abort: vi.fn()
    }
    const runner = new AgentRunner({
      chatService: chatService as any,
      toolManager: { getToolDefinitions: () => [] } as any,
      editTransactionService: {
        beginTransaction: async () => 'tx-idle',
        rollback: async () => undefined
      } as any
    })
    const onDone = vi.fn()

    await runner.run({
      baseUrl: 'https://example.test', apiKey: 'key', model: 'm1', workspaceRoot: root,
      tools: [], providerId: 'p1', runtimeTurn: turn, runtimeCoordinator: runtime,
      contextBuilder: new ModelContextBuilder(ledger),
      contextCapabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system'
    }, {
      onChunk: () => undefined,
      onDone,
      onError: (error) => { throw new Error(error) }
    })

    expect(chatService.streamChat).toHaveBeenCalledTimes(3)
    expect(continuationSpy).toHaveBeenCalledTimes(2)
    expect(continuationSpy.mock.calls.every(([, message]) => message.includes('<internal_continuation>'))).toBe(true)
    expect(onDone).toHaveBeenCalledWith('progress update 3', 'stop', 'tx-idle')
    expect((await ledger.load(sessionId)).scopes.main.lastCompletedTurnId).toBe(turn.turnId)
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

  it('keeps the durable scope busy until an aborted transaction finishes rollback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-runner-abort-'))
    dirs.push(root)
    const ledger = new ModelLedgerStore(path.join(root, 'runtime'))
    const runtime = new SessionRuntimeCoordinator(ledger)
    const turn = await runtime.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: 'wait', providerId: 'p1', model: 'm1'
    })
    let markProviderStarted!: () => void
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve })
    const chatService = {
      streamChat: vi.fn(async (_config: unknown, _callbacks: unknown, signal: AbortSignal) => {
        markProviderStarted()
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve()
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }),
      abort: vi.fn()
    }
    let markRollbackStarted!: () => void
    let finishRollback!: () => void
    const rollbackStarted = new Promise<void>((resolve) => { markRollbackStarted = resolve })
    const rollbackGate = new Promise<void>((resolve) => { finishRollback = resolve })
    const rollback = vi.fn(async () => {
      markRollbackStarted()
      await rollbackGate
    })
    const runner = new AgentRunner({
      chatService: chatService as any,
      toolManager: { getToolDefinitions: () => [] } as any,
      editTransactionService: {
        beginTransaction: async () => 'tx-abort', rollback
      } as any
    })
    const run = runner.run({
      baseUrl: 'https://example.test', apiKey: 'key', model: 'm1', workspaceRoot: root,
      tools: [], providerId: 'p1', runtimeTurn: turn, runtimeCoordinator: runtime,
      contextBuilder: new ModelContextBuilder(ledger),
      contextCapabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system'
    }, {
      onChunk: () => undefined,
      onDone: () => { throw new Error('aborted run must not be handed off') },
      onError: () => undefined
    })

    await providerStarted
    runner.abort()
    await rollbackStarted
    expect(runtime.isScopeBusy('s1', 'main')).toBe(true)
    finishRollback()
    await run

    expect(rollback).toHaveBeenCalledWith('tx-abort')
    expect(runtime.isScopeBusy('s1', 'main')).toBe(false)
  })
})
