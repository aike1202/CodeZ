import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { AgentRunner } from '../main/agent/AgentRunner'
import { SubAgentManager, type SubAgentResult } from '../main/agent/SubAgentManager'
import {
  AgentCollaborationRuntime,
  AgentMailbox,
  AgentRegistry,
  getAgentCollaborationRuntime,
  resetAgentCollaborationRuntimeForTests,
} from '../main/services/agents'
import { ModelContextBuilder } from '../main/services/context/ModelContextBuilder'
import { ModelLedgerStore } from '../main/services/context/ModelLedgerStore'
import { SessionRuntimeCoordinator } from '../main/services/context/SessionRuntimeCoordinator'
import type { AgentRecord } from '../shared/types/subagent'

const tempDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  resetAgentCollaborationRuntimeForTests()
  await Promise.all(tempDirs.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'agent-1',
    sessionId: 'session-1',
    parentAgentId: '/root',
    parentPath: '/root',
    path: '/root/explore_auth',
    type: 'Explore',
    taskName: 'explore_auth',
    description: 'Explore auth',
    status: 'running',
    contextScopeId: 'subagent:agent-1',
    createdAt: 1,
    updatedAt: 1,
    runCount: 1,
    ...overrides,
  }
}

function result(report = '## Result\n\nCompleted.'): SubAgentResult {
  return {
    type: 'Explore',
    status: 'completed',
    output: report,
    structuredOutput: {
      report,
      conclusion: 'Completed.',
      confidence: 'high',
    },
    toolCallCount: 2,
    filesExamined: ['src/auth.ts'],
  }
}

function environment(sessionId = 'session-1') {
  return {
    config: {
      sessionId,
      workspaceRoot: process.cwd(),
      providerId: 'provider-1',
      baseUrl: 'https://example.invalid',
      apiKey: 'test-key',
      apiFormat: 'openai',
      model: 'test-model',
      contextCapabilities: { contextWindowTokens: 32_000, maxOutputTokens: 2_000 },
    },
    callbacks: {
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    },
    parentContextScopeId: 'main' as const,
  }
}

async function eventually(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      assertion()
      return
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
}

describe('AgentRegistry', () => {
  it('retains completed handles and recovers in-flight records as interrupted', async () => {
    const saveAgents = vi.fn(async () => undefined)
    const registry = new AgentRegistry()
    registry.configurePersistence({ saveAgents })

    await registry.create(record({ status: 'completed' }))
    expect(registry.resolve('session-1', '/root/explore_auth')?.id).toBe('agent-1')

    const restored = new AgentRegistry()
    restored.configurePersistence({ saveAgents })
    await restored.restoreSession('session-1', [record()])

    expect(restored.get('agent-1')).toMatchObject({
      status: 'interrupted',
      result: {
        status: 'interrupted',
        handoff: { reasonCode: 'runtime_missing', canResume: true },
      },
    })
    expect(saveAgents).toHaveBeenCalled()
  })
})

describe('AgentMailbox', () => {
  it('persists unread messages, consumes them once, and wakes waiters', async () => {
    const saveMessages = vi.fn(async () => undefined)
    const mailbox = new AgentMailbox()
    mailbox.configurePersistence({ saveMessages })

    await mailbox.post({
      sessionId: 'session-1',
      type: 'MESSAGE',
      author: '/root/explore_auth',
      recipient: '/root',
      payload: 'First update',
    })
    expect(mailbox.peekUnread('session-1', '/root')).toHaveLength(1)
    expect(await mailbox.consume('session-1', '/root')).toHaveLength(1)
    expect(await mailbox.consume('session-1', '/root')).toEqual([])

    const waiting = mailbox.waitForUnread('session-1', '/root', 1_000)
    await mailbox.post({
      sessionId: 'session-1',
      type: 'FINAL_ANSWER',
      author: '/root/explore_auth',
      recipient: '/root',
      payload: '## Final\n\nDone.',
    })
    await expect(waiting).resolves.toEqual([
      expect.objectContaining({ type: 'FINAL_ANSWER', payload: '## Final\n\nDone.' }),
    ])
    expect(saveMessages).toHaveBeenCalled()
  })
})

describe('AgentCollaborationRuntime', () => {
  it('returns from spawn before completion and posts the Markdown FINAL_ANSWER', async () => {
    let finish!: (value: SubAgentResult) => void
    const run = new Promise<SubAgentResult>((resolve) => { finish = resolve })
    vi.spyOn(SubAgentManager, 'spawn').mockReturnValue(run)
    const runtime = new AgentCollaborationRuntime()

    const spawned = await runtime.spawn({
      type: 'Explore',
      taskName: 'explore_auth',
      description: 'Explore auth',
      message: 'Trace auth.',
      context: 'Auth middleware has already been located.',
      expectations: { questions: ['Which branch rejects the token?'] },
      scope: { directories: ['src/auth'] },
      depth: 'quick',
      permissionScope: { allowBash: true, allowedWriteFiles: ['src/auth.ts'] },
    }, environment() as any)

    expect(spawned.id).toMatch(/^agent_/)
    expect(spawned.path).toBe('/root/explore_auth')
    expect(runtime.registry.get(spawned.id)?.status).not.toBe('completed')

    const finalAnswer = runtime.mailbox.waitForUnread('session-1', '/root', 1_000)
    finish(result())

    await expect(finalAnswer).resolves.toEqual([
      expect.objectContaining({
        type: 'FINAL_ANSWER',
        author: '/root/explore_auth',
        payload: '## Result\n\nCompleted.',
      }),
    ])
    expect(runtime.registry.get(spawned.id)).toMatchObject({ status: 'completed' })
  })

  it('reuses the same durable identity and context for follow-up work', async () => {
    const contexts: any[] = []
    vi.spyOn(SubAgentManager, 'spawn').mockImplementation(async (_type, context) => {
      contexts.push(context)
      return result(context.continuationMode ? '## Follow-up\n\nDone.' : '## Initial\n\nDone.')
    })
    const runtime = new AgentCollaborationRuntime()
    const spawned = await runtime.spawn({
      type: 'Explore',
      taskName: 'explore_auth',
      description: 'Explore auth',
      message: 'Trace auth.',
      context: 'Auth middleware has already been located.',
      expectations: { questions: ['Which branch rejects the token?'] },
      scope: { directories: ['src/auth'] },
      depth: 'quick',
      permissionScope: { allowBash: true, allowedWriteFiles: ['src/auth.ts'] },
    }, environment() as any)
    await eventually(() => expect(runtime.registry.get(spawned.id)?.status).toBe('completed'))
    await runtime.consumeForAgent('session-1', '/root')

    const followed = await runtime.followup(
      spawned.id,
      'Check the remaining branch.',
      environment() as any
    )
    await eventually(() => expect(runtime.registry.get(spawned.id)?.status).toBe('completed'))

    expect(followed.id).toBe(spawned.id)
    expect(runtime.registry.get(spawned.id)?.runCount).toBe(2)
    expect(contexts[1]).toMatchObject({
      subAgentId: spawned.id,
      resumeSubAgentId: spawned.id,
      continuationMode: 'followup',
      task: 'Check the remaining branch.',
      context: 'Auth middleware has already been located.',
      expectations: { questions: ['Which branch rejects the token?'] },
      scope: { directories: ['src/auth'] },
      depth: 'quick',
      permissionScope: { allowBash: true, allowedWriteFiles: ['src/auth.ts'] },
    })
  })

  it('interrupts the active turn while retaining the Agent record', async () => {
    vi.spyOn(SubAgentManager, 'spawn').mockImplementation(async (_type, context) =>
      new Promise<SubAgentResult>((resolve) => {
        context.parentSignal?.addEventListener('abort', () => resolve({
          type: 'Explore',
          status: 'interrupted',
          output: 'Stopped by parent.',
          toolCallCount: 0,
          filesExamined: [],
        }), { once: true })
      })
    )
    const runtime = new AgentCollaborationRuntime()
    const spawned = await runtime.spawn({
      type: 'Explore',
      taskName: 'explore_auth',
      description: 'Explore auth',
      message: 'Trace auth.',
    }, environment() as any)
    await eventually(() => expect(runtime.registry.get(spawned.id)?.status).toBe('running'))

    expect(runtime.interrupt('session-1', spawned.id)).toBe(true)
    await eventually(() => expect(runtime.registry.get(spawned.id)?.status).toBe('interrupted'))
    expect(runtime.registry.get(spawned.id)).toBeDefined()
  })
})

describe('AgentRunner mailbox integration', () => {
  it('injects a root FINAL_ANSWER into the canonical input ledger', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-agent-mailbox-'))
    tempDirs.push(root)
    const ledger = new ModelLedgerStore(path.join(root, 'runtime'))
    const coordinator = new SessionRuntimeCoordinator(ledger)
    const continuation = vi.spyOn(coordinator, 'recordUserContinuation')
    const turn = await coordinator.beginTurn({
      sessionId: 'mailbox-session',
      contextScopeId: 'main',
      text: 'Wait for delegated work.',
      providerId: 'provider-1',
      model: 'test-model',
    })
    await getAgentCollaborationRuntime().mailbox.post({
      sessionId: 'mailbox-session',
      type: 'FINAL_ANSWER',
      author: '/root/explore_auth',
      recipient: '/root',
      payload: '## Findings\n\nThe delegated result is ready.',
    })

    const runner = new AgentRunner({
      chatService: {
        streamChat: vi.fn(async (_config, callbacks) => {
          callbacks.onChunk('Integrated result.', '')
          callbacks.onDone('Integrated result.', 'stop')
        }),
        abort: vi.fn(),
      } as any,
      toolManager: { getToolDefinitions: () => [] } as any,
      editTransactionService: {
        beginTransaction: async () => 'tx-mailbox',
        rollback: async () => undefined,
      } as any,
    })

    await runner.run({
      sessionId: 'mailbox-session',
      workspaceRoot: root,
      providerId: 'provider-1',
      baseUrl: 'https://example.invalid',
      apiKey: 'test-key',
      apiFormat: 'openai',
      model: 'test-model',
      tools: [],
      runtimeTurn: turn,
      runtimeCoordinator: coordinator,
      contextBuilder: new ModelContextBuilder(ledger),
      contextCapabilities: { contextWindowTokens: 32_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system',
    }, {
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: (error) => { throw new Error(error) },
    })

    expect(continuation).toHaveBeenCalledWith(
      turn,
      expect.stringContaining('Message Type: FINAL_ANSWER')
    )
    expect(continuation).toHaveBeenCalledWith(
      turn,
      expect.stringContaining('The delegated result is ready.')
    )
  })

  it('continues instead of terminating when a FINAL_ANSWER arrives during a model turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-agent-mailbox-late-'))
    tempDirs.push(root)
    const ledger = new ModelLedgerStore(path.join(root, 'runtime'))
    const coordinator = new SessionRuntimeCoordinator(ledger)
    const turn = await coordinator.beginTurn({
      sessionId: 'late-mailbox-session',
      contextScopeId: 'main',
      text: 'Wait for delegated work.',
      providerId: 'provider-1',
      model: 'test-model',
    })
    const runtime = getAgentCollaborationRuntime()
    let modelTurn = 0
    const streamChat = vi.fn(async (_config, callbacks) => {
      modelTurn++
      if (modelTurn === 1) {
        await runtime.mailbox.post({
          sessionId: 'late-mailbox-session',
          type: 'FINAL_ANSWER',
          author: '/root/explore_auth',
          recipient: '/root',
          payload: '## Late findings\n\nUse the delegated evidence.',
        })
        callbacks.onChunk('Answer before delegated evidence.', '')
        callbacks.onDone('Answer before delegated evidence.', 'stop')
        return
      }
      callbacks.onChunk('Answer with delegated evidence.', '')
      callbacks.onDone('Answer with delegated evidence.', 'stop')
    })
    const onDone = vi.fn()
    const runner = new AgentRunner({
      chatService: { streamChat, abort: vi.fn() } as any,
      toolManager: { getToolDefinitions: () => [] } as any,
      editTransactionService: {
        beginTransaction: async () => 'tx-late-mailbox',
        rollback: async () => undefined,
      } as any,
    })

    await runner.run({
      sessionId: 'late-mailbox-session',
      workspaceRoot: root,
      providerId: 'provider-1',
      baseUrl: 'https://example.invalid',
      apiKey: 'test-key',
      apiFormat: 'openai',
      model: 'test-model',
      tools: [],
      runtimeTurn: turn,
      runtimeCoordinator: coordinator,
      contextBuilder: new ModelContextBuilder(ledger),
      contextCapabilities: { contextWindowTokens: 32_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system',
    }, {
      onChunk: vi.fn(),
      onDone,
      onError: (error) => { throw new Error(error) },
    })

    expect(streamChat).toHaveBeenCalledTimes(2)
    expect(onDone).toHaveBeenCalledWith(
      'Answer with delegated evidence.',
      'stop',
      'tx-late-mailbox'
    )
    const scope = (await ledger.load('late-mailbox-session')).scopes.main
    expect(scope.activeMessages.some((message) =>
      message.role === 'user' && String(message.content).includes('Late findings')
    )).toBe(true)
  })
})
