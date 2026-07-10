import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
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

describe('SubAgent canonical context scope', () => {
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
    chatMock.streamChat.mockImplementationOnce(async (_config, callbacks) => {
      callbacks.onChunk('sub answer', '')
      callbacks.onDone('sub answer', 'stop')
    })

    await SubAgentManager.spawn('ContextScopeTest', {
      workspaceRoot: root,
      sessionId: 's1',
      task: 'sub input',
      parentPrompt: 'sub input',
      apiConfig: {
        baseUrl: 'https://example.invalid', apiKey: 'key', apiFormat: 'openai', model: 'm1'
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
    const state = await ledger.load('s1')
    expect(state.scopes.main.historyVersion).toBe(mainVersion)
    expect(Object.keys(state.scopes)).toEqual(expect.arrayContaining([
      'main', expect.stringMatching(/^subagent:/)
    ]))
  })
})
