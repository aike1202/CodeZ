import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import type { ToolDefinition } from '../shared/types/provider'

const chatMock = vi.hoisted(() => ({ streamChat: vi.fn() }))

vi.mock('../main/services/ChatService', () => ({
  ChatService: vi.fn().mockImplementation(() => ({
    streamChat: chatMock.streamChat,
    abort: vi.fn()
  }))
}))

const dirs: string[] = []

afterEach(async () => {
  chatMock.streamChat.mockReset()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('SubAgent canonical context scope', { timeout: 15_000 }, () => {
  it('uses resolved model capabilities without changing the main scope version', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-subagent-scope-'))
    dirs.push(root)
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')
    const { ModelLedgerStore } = await import('../main/services/context/ModelLedgerStore')
    const { SessionRuntimeCoordinator } = await import('../main/services/context/SessionRuntimeCoordinator')
    const { ModelContextBuilder } = await import('../main/services/context/ModelContextBuilder')

    SubAgentManager.register({
      type: 'ContextScopeTest',
      description: 'context scope test agent',
      whenToUse: 'test',
      maxLoops: 2,
      getTools: (): ToolDefinition[] => [],
      systemPromptBuilder: () => 'test subagent'
    })

    const ledger = new ModelLedgerStore(path.join(root, 'runtime'))
    const coordinator = new SessionRuntimeCoordinator(ledger)
    const mainTurn = await coordinator.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: 'main input'
    })
    await coordinator.recordAssistant(mainTurn, { content: 'main answer' })
    await coordinator.completeTurn(mainTurn, { stopReason: 'stop' })
    const mainVersion = (await ledger.load('s1')).scopes.main.historyVersion

    const builder = new ModelContextBuilder(ledger)
    const buildSpy = vi.spyOn(builder, 'build')
    let requestConfig: any
    chatMock.streamChat.mockImplementationOnce(async (config, callbacks) => {
      requestConfig = config
      callbacks.onChunk('sub answer', '')
      callbacks.onUsage({ inputTokens: 100, outputTokens: 0, totalTokens: 100 })
      callbacks.onUsage({ inputTokens: 0, outputTokens: 7, totalTokens: 7 })
      callbacks.onDone('sub answer', 'stop')
    })

    await SubAgentManager.spawn('ContextScopeTest', {
      workspaceRoot: root,
      sessionId: 's1',
      task: 'sub input',
      parentPrompt: 'sub input',
      apiConfig: {
        baseUrl: 'https://example.invalid', apiKey: 'key', apiFormat: 'openai', model: 'm1',
        maxOutputTokens: 4_096
      },
      contextCapabilities: { contextWindowTokens: 65_536, maxOutputTokens: 4_096 },
      runtimeCoordinator: coordinator,
      contextBuilder: builder
    }, {
      onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn()
    })

    expect(buildSpy).toHaveBeenCalledWith(expect.objectContaining({
      contextScopeId: expect.stringMatching(/^subagent:/),
      capabilities: { contextWindowTokens: 65_536, maxOutputTokens: 4_096 }
    }))
    expect(requestConfig.maxOutputTokens).toBe(4_096)
    const state = await ledger.load('s1')
    expect(state.scopes.main.historyVersion).toBe(mainVersion)
    expect(Object.keys(state.scopes)).toEqual(expect.arrayContaining([
      'main', expect.stringMatching(/^subagent:/)
    ]))
    const subScope = Object.values(state.scopes).find((scope) => scope !== state.scopes.main)
    expect(subScope?.lastProviderUsage).toMatchObject({ inputTokens: 100, outputTokens: 7 })
    expect(subScope?.lastProviderUsageRequestFingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('continues an interrupted subagent from its durable history', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-subagent-resume-'))
    dirs.push(root)
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')
    const { ModelLedgerStore } = await import('../main/services/context/ModelLedgerStore')
    const { SessionRuntimeCoordinator } = await import('../main/services/context/SessionRuntimeCoordinator')
    const { ModelContextBuilder } = await import('../main/services/context/ModelContextBuilder')

    SubAgentManager.register({
      type: 'ContextResumeTest',
      description: 'context resume test agent',
      whenToUse: 'test',
      maxLoops: 2,
      getTools: (): ToolDefinition[] => [],
      systemPromptBuilder: () => 'test resumable subagent'
    })

    const ledger = new ModelLedgerStore(path.join(root, 'runtime'))
    const coordinator = new SessionRuntimeCoordinator(ledger)
    const contextScopeId = 'subagent:subagent_tool-resume' as const
    const interruptedTurn = await coordinator.beginTurn({
      sessionId: 's1', contextScopeId, text: 'inspect the repository'
    })
    await coordinator.recordAssistant(interruptedTurn, {
      content: 'Durable finding: package metadata was already inspected.'
    })
    await coordinator.interruptTurn(interruptedTurn, 'parent was interrupted')

    let resumedMessages: Array<{ role: string; content?: string }> = []
    chatMock.streamChat.mockImplementationOnce(async (config, callbacks) => {
      resumedMessages = config.messages
      callbacks.onChunk('resumed answer', '')
      callbacks.onDone('resumed answer', 'stop')
    })

    await SubAgentManager.spawn('ContextResumeTest', {
      workspaceRoot: root,
      sessionId: 's1',
      task: 'inspect the repository',
      parentPrompt: 'inspect the repository',
      subAgentId: 'subagent_tool-resume',
      resumeSubAgentId: 'subagent_tool-resume',
      apiConfig: {
        baseUrl: 'https://example.invalid', apiKey: 'key', apiFormat: 'openai', model: 'm1'
      },
      contextCapabilities: { contextWindowTokens: 65_536, maxOutputTokens: 4_096 },
      runtimeCoordinator: coordinator,
      contextBuilder: new ModelContextBuilder(ledger)
    }, {
      onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn()
    })

    expect(resumedMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: 'Durable finding: package metadata was already inspected.'
      }),
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Continue the interrupted task')
      })
    ]))
    const scope = (await ledger.load('s1')).scopes[contextScopeId]
    expect(scope.lastCompletedTurnId).toBe(scope.activeMessages.at(-1)?.turnId)
  })

  it('persists subagent Read metadata and rebuilds its scoped file authorization', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-subagent-files-'))
    dirs.push(root)
    const filePath = path.join(root, 'active.ts')
    await writeFile(filePath, 'export const active = true\n')
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')
    const { ModelLedgerStore } = await import('../main/services/context/ModelLedgerStore')
    const { SessionRuntimeCoordinator } = await import('../main/services/context/SessionRuntimeCoordinator')
    const { ModelContextBuilder } = await import('../main/services/context/ModelContextBuilder')
    const { getReadFingerprintStore } = await import('../main/tools/ReadFingerprintStore')

    SubAgentManager.register({
      type: 'ContextFileTest',
      description: 'file context test agent',
      whenToUse: 'test',
      maxLoops: 3,
      getTools: (manager) => manager.getToolDefinitions()
        .filter((tool) => tool.function.name === 'Read'),
      systemPromptBuilder: () => 'test file context subagent'
    })

    const ledger = new ModelLedgerStore(path.join(root, 'runtime'))
    const coordinator = new SessionRuntimeCoordinator(ledger)
    let call = 0
    chatMock.streamChat.mockImplementation(async (_config, callbacks) => {
      call++
      if (call === 1) {
        callbacks.onChunk('', '', [{
          index: 0,
          id: 'read-1',
          function: {
            name: 'Read',
            arguments: JSON.stringify({ files: [{ file_path: filePath }] })
          }
        }])
        callbacks.onDone('', 'tool_calls')
      } else {
        callbacks.onChunk('done', '')
        callbacks.onDone('done', 'stop')
      }
    })

    await SubAgentManager.spawn('ContextFileTest', {
      workspaceRoot: root,
      sessionId: 's1',
      task: 'read active file',
      parentPrompt: 'read active file',
      subAgentId: 'file-context',
      apiConfig: {
        baseUrl: 'https://example.invalid', apiKey: 'key', apiFormat: 'openai', model: 'm1',
        maxOutputTokens: 4_096
      },
      contextCapabilities: { contextWindowTokens: 65_536, maxOutputTokens: 4_096 },
      runtimeCoordinator: coordinator,
      contextBuilder: new ModelContextBuilder(ledger)
    }, {
      onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn()
    })

    const scopeId = 'subagent:file-context' as const
    const scope = (await ledger.load('s1')).scopes[scopeId]
    const reference = scope.activeMessages.find((message) => message.name === 'Read')
      ?.fileReferences?.[0]
    expect(reference).toMatchObject({ path: filePath, operation: 'read', contentIncluded: true })
    expect(getReadFingerprintStore().hasDelivery('s1', scopeId, filePath, reference!.sha256)).toBe(true)
  })

  it('executes shared-worker writes inside the parent edit transaction', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-subagent-transaction-'))
    dirs.push(root)
    const filePath = path.join(root, 'worker.txt')
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')
    const { ModelLedgerStore } = await import('../main/services/context/ModelLedgerStore')
    const { SessionRuntimeCoordinator } = await import('../main/services/context/SessionRuntimeCoordinator')
    const { ModelContextBuilder } = await import('../main/services/context/ModelContextBuilder')

    SubAgentManager.register({
      type: 'ContextTransactionTest',
      description: 'transaction propagation test agent',
      whenToUse: 'test',
      maxLoops: 3,
      getTools: (manager) => manager.getToolDefinitions()
        .filter((tool) => tool.function.name === 'Write'),
      systemPromptBuilder: () => 'test transaction subagent'
    })

    const backupFile = vi.fn(async () => true)
    const editTransactionService = {
      backupFile,
      getDiff: vi.fn(async () => [])
    } as any
    const ledger = new ModelLedgerStore(path.join(root, 'runtime'))
    const coordinator = new SessionRuntimeCoordinator(ledger)
    let call = 0
    chatMock.streamChat.mockImplementation(async (_config, callbacks) => {
      call++
      if (call === 1) {
        callbacks.onChunk('', '', [{
          index: 0,
          id: 'write-1',
          function: {
            name: 'Write',
            arguments: JSON.stringify({ file_path: filePath, content: 'from worker\n', approval: 'auto' })
          }
        }])
        callbacks.onDone('', 'tool_calls')
      } else {
        callbacks.onChunk('done', '')
        callbacks.onDone('done', 'stop')
      }
    })

    await SubAgentManager.spawn('ContextTransactionTest', {
      workspaceRoot: root,
      sessionId: 's1',
      task: 'write the assigned file',
      parentPrompt: 'write the assigned file',
      subAgentId: 'transaction-context',
      permissionScope: { allowedWriteFiles: [filePath] },
      transactionId: 'tx-parent',
      editTransactionService,
      apiConfig: {
        baseUrl: 'https://example.invalid', apiKey: 'key', apiFormat: 'openai', model: 'm1'
      },
      contextCapabilities: { contextWindowTokens: 65_536, maxOutputTokens: 4_096 },
      runtimeCoordinator: coordinator,
      contextBuilder: new ModelContextBuilder(ledger)
    }, {
      onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn()
    })

    expect(backupFile).toHaveBeenCalledWith('tx-parent', filePath, null)
    expect(await readFile(filePath, 'utf-8')).toBe('from worker\n')
  })

  it('replays a durably completed result without running the subagent again', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-subagent-replay-'))
    dirs.push(root)
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')
    const { ModelLedgerStore } = await import('../main/services/context/ModelLedgerStore')
    const { SessionRuntimeCoordinator } = await import('../main/services/context/SessionRuntimeCoordinator')
    const { ModelContextBuilder } = await import('../main/services/context/ModelContextBuilder')

    SubAgentManager.register({
      type: 'ContextReplayTest',
      description: 'context replay test agent',
      whenToUse: 'test',
      maxLoops: 2,
      getTools: (): ToolDefinition[] => [],
      systemPromptBuilder: () => 'test replayable subagent'
    })

    const ledger = new ModelLedgerStore(path.join(root, 'runtime'))
    const coordinator = new SessionRuntimeCoordinator(ledger)
    const builder = new ModelContextBuilder(ledger)
    const context = {
      workspaceRoot: root,
      sessionId: 's1',
      task: 'inspect once',
      parentPrompt: 'inspect once',
      subAgentId: 'subagent_tool-replay',
      apiConfig: {
        baseUrl: 'https://example.invalid', apiKey: 'key', apiFormat: 'openai', model: 'm1'
      },
      contextCapabilities: { contextWindowTokens: 65_536, maxOutputTokens: 4_096 },
      runtimeCoordinator: coordinator,
      contextBuilder: builder
    }
    const callbacks = { onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    chatMock.streamChat.mockImplementationOnce(async (_config, streamCallbacks) => {
      streamCallbacks.onChunk('durable completed answer', '')
      streamCallbacks.onDone('durable completed answer', 'stop')
    })

    const completed = await SubAgentManager.spawn('ContextReplayTest', context, callbacks)
    const replayed = await SubAgentManager.spawn('ContextReplayTest', {
      ...context,
      resumeSubAgentId: context.subAgentId
    }, callbacks)

    expect(completed).toMatchObject({ status: 'completed', output: 'durable completed answer' })
    expect(replayed).toMatchObject({ status: 'completed', output: 'durable completed answer' })
    expect(chatMock.streamChat).toHaveBeenCalledTimes(1)
  })

  it('preserves a resumable handoff when the subagent runtime fails after making progress', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-subagent-runtime-failure-'))
    dirs.push(root)
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')
    const { ModelLedgerStore } = await import('../main/services/context/ModelLedgerStore')
    const { SessionRuntimeCoordinator } = await import('../main/services/context/SessionRuntimeCoordinator')
    const { ModelContextBuilder } = await import('../main/services/context/ModelContextBuilder')

    SubAgentManager.register({
      type: 'ContextRuntimeFailureTest',
      description: 'runtime failure handoff test agent',
      whenToUse: 'test',
      maxLoops: 2,
      getTools: (): ToolDefinition[] => [],
      systemPromptBuilder: () => 'test runtime failure subagent',
      outputSpec: {
        description: 'test result',
        fields: [
          { name: 'report', type: 'string', description: 'report', required: true },
          { name: 'conclusion', type: 'string', description: 'conclusion', required: true },
          { name: 'confidence', type: 'string', description: 'confidence', required: true }
        ]
      }
    })

    const ledger = new ModelLedgerStore(path.join(root, 'runtime'))
    const coordinator = new SessionRuntimeCoordinator(ledger)
    const realBuilder = new ModelContextBuilder(ledger)
    let buildCount = 0
    const failingBuilder = {
      build: vi.fn(async (request: any) => {
        buildCount++
        if (buildCount === 2) throw new Error('context bridge failed')
        return realBuilder.build(request)
      })
    } as any
    chatMock.streamChat.mockImplementationOnce(async (_config, callbacks) => {
      callbacks.onChunk('Durable progress before the runtime failure.', '')
      callbacks.onDone('Durable progress before the runtime failure.', 'stop')
    })

    const result = await SubAgentManager.spawn('ContextRuntimeFailureTest', {
      workspaceRoot: root,
      sessionId: 's1',
      task: 'finish the bridge',
      parentPrompt: 'finish the bridge',
      subAgentId: 'subagent-runtime-failure',
      apiConfig: {
        baseUrl: 'https://example.invalid', apiKey: 'key', apiFormat: 'openai', model: 'm1'
      },
      contextCapabilities: { contextWindowTokens: 65_536, maxOutputTokens: 4_096 },
      runtimeCoordinator: coordinator,
      contextBuilder: failingBuilder
    }, {
      onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn()
    })

    expect(result).toMatchObject({
      status: 'failed',
      output: 'context bridge failed',
      handoff: {
        reasonCode: 'runtime_error',
        reason: 'context bridge failed',
        originalTask: 'finish the bridge',
        lastProgress: 'Durable progress before the runtime failure.',
        canResume: true
      }
    })
    const scope = (await ledger.load('s1')).scopes['subagent:subagent-runtime-failure']
    expect(scope.lastInterruptedTurnId).toBe(scope.activeMessages.at(-1)?.turnId)
  })

  it('compacts and retries once after a SubAgent provider context overflow', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-subagent-overflow-'))
    dirs.push(root)
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')
    const { ModelLedgerStore } = await import('../main/services/context/ModelLedgerStore')
    const { SessionRuntimeCoordinator } = await import('../main/services/context/SessionRuntimeCoordinator')
    const { ModelContextBuilder } = await import('../main/services/context/ModelContextBuilder')

    SubAgentManager.register({
      type: 'ContextOverflowTest',
      description: 'context overflow test agent',
      whenToUse: 'test',
      maxLoops: 2,
      getTools: (): ToolDefinition[] => [],
      systemPromptBuilder: () => 'test overflow recovery'
    })
    const ledger = new ModelLedgerStore(path.join(root, 'runtime'))
    const coordinator = new SessionRuntimeCoordinator(ledger)
    const compact = vi.fn().mockResolvedValue({ status: 'completed' })
    let calls = 0
    chatMock.streamChat.mockImplementation(async (_config, callbacks) => {
      calls++
      if (calls === 1) {
        callbacks.onError('too many tokens', 'CONTEXT_OVERFLOW')
      } else {
        callbacks.onChunk('recovered', '')
        callbacks.onDone('recovered', 'stop')
      }
    })

    const result = await SubAgentManager.spawn('ContextOverflowTest', {
      workspaceRoot: root,
      sessionId: 's1',
      providerId: 'p1',
      task: 'recover overflow',
      parentPrompt: 'recover overflow',
      subAgentId: 'overflow-context',
      apiConfig: {
        baseUrl: 'https://example.invalid', apiKey: 'key', apiFormat: 'openai', model: 'm1'
      },
      contextCapabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
      runtimeCoordinator: coordinator,
      contextBuilder: new ModelContextBuilder(ledger),
      compactionService: { compact } as any
    }, {
      onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn()
    })

    expect(result).toMatchObject({ status: 'completed', output: 'recovered' })
    expect(chatMock.streamChat).toHaveBeenCalledTimes(2)
    expect(compact).toHaveBeenCalledWith(expect.objectContaining({
      trigger: 'provider_overflow',
      requiredMessageId: expect.any(String)
    }))
  })
})
