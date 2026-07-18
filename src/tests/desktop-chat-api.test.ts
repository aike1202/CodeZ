import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tauriMocks = vi.hoisted(() => {
  const channels: Array<{ onmessage?: (message: unknown) => void }> = []
  return {
    channels,
    invoke: vi.fn(),
    listen: vi.fn(),
    unlisten: vi.fn(),
    listeners: new Map<string, (event: { payload: unknown }) => void>()
  }
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
  Channel: class<T> {
    onmessage?: (message: T) => void

    constructor() {
      tauriMocks.channels.push(this as unknown as { onmessage?: (message: unknown) => void })
    }
  }
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: tauriMocks.listen
}))

import { desktopApi } from '../renderer/src/shared/desktop/api'

let originalWindow: unknown

function setWindow(value: unknown): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value,
    writable: true
  })
}

describe('desktop chat adapter', () => {
  beforeEach(() => {
    originalWindow = (globalThis as { window?: unknown }).window
    tauriMocks.channels.length = 0
    tauriMocks.invoke.mockReset()
    tauriMocks.unlisten.mockReset()
    tauriMocks.listeners.clear()
    tauriMocks.listen.mockImplementation((eventName: string, callback: (event: { payload: unknown }) => void) => {
      tauriMocks.listeners.set(eventName, callback)
      return Promise.resolve(tauriMocks.unlisten)
    })
  })

  afterEach(() => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window')
      return
    }
    setWindow(originalWindow)
  })

  it('maps non-streaming chat commands to their Tauri command names and camelCase arguments', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    tauriMocks.invoke
      .mockResolvedValueOnce({ suggestion: ' next' })
      .mockResolvedValueOnce({ sessionId: 'session-1', mainRunnerActive: false })
      .mockResolvedValueOnce({ accepted: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ accepted: true, result: { status: 'completed' } })
      .mockResolvedValueOnce({ historyVersion: 7 })
      .mockResolvedValueOnce({ toDelete: ['new.ts'], toRestore: ['old.ts'] })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce([{ path: 'C:\\workspace\\file.ts', diff: '@@' }])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)

    await expect(desktopApi.chat.predictNextInput({
      providerId: 'provider-1',
      model: 'model-1',
      context: [],
      draft: 'draft'
    })).resolves.toEqual({ suggestion: ' next' })
    await desktopApi.chat.getRuntimeStatus('session-1')
    await desktopApi.chat.steer('session-1', { queueId: 'queue-1', text: 'Continue' })
    await desktopApi.chat.interruptTool('tool-1')
    await desktopApi.chat.compact('session-1', 'Keep decisions')
    await expect(desktopApi.chat.revertHistory(
      'session-1',
      'message-1',
      ['tx-2', 'tx-1']
    )).resolves.toEqual({ historyVersion: 7 })
    await expect(desktopApi.chat.previewHistoryRevert(
      'session-1',
      'message-1',
      ['tx-2', 'tx-1']
    )).resolves.toEqual({ toDelete: ['new.ts'], toRestore: ['old.ts'] })
    await desktopApi.chat.acceptFile('tx-1', 'C:\\workspace\\file.ts')
    await desktopApi.chat.rejectFile('tx-1', 'C:\\workspace\\file.ts')
    await desktopApi.chat.getDiff('tx-1')
    await desktopApi.chat.respondToApproval('approval-1', { approved: true, scope: 'once' })
    await desktopApi.chat.respondAskUser('ask-1', [{ question: 'Continue?', answer: 'yes' }])

    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['chat_predict_next_input', {
        request: { providerId: 'provider-1', model: 'model-1', context: [], draft: 'draft' }
      }],
      ['chat_get_runtime_status', { sessionId: 'session-1' }],
      ['chat_steer', { sessionId: 'session-1', input: { queueId: 'queue-1', text: 'Continue' } }],
      ['chat_interrupt_tool', { toolCallId: 'tool-1' }],
      ['chat_compact', { sessionId: 'session-1', instructions: 'Keep decisions' }],
      ['chat_revert_history', {
        sessionId: 'session-1', messageId: 'message-1', transactionIds: ['tx-2', 'tx-1']
      }],
      ['chat_preview_history_revert', {
        sessionId: 'session-1', messageId: 'message-1', transactionIds: ['tx-2', 'tx-1']
      }],
      ['chat_accept_file', { txId: 'tx-1', filePath: 'C:\\workspace\\file.ts' }],
      ['chat_reject_file', { txId: 'tx-1', filePath: 'C:\\workspace\\file.ts' }],
      ['chat_get_diff', { txId: 'tx-1' }],
      ['chat_respond_to_approval', {
        requestId: 'approval-1', response: { approved: true, scope: 'once' }
      }],
      ['chat_respond_ask_user', {
        requestId: 'ask-1', answers: [{ question: 'Continue?', answer: 'yes' }]
      }]
    ])
  })

  it('delivers and acknowledges Tauri stream frames, then disposes listeners on completion', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    tauriMocks.invoke.mockImplementation((command: string, args?: { request?: { streamId?: string } }) => {
      if (command === 'chat_stream_start') return Promise.resolve(args?.request?.streamId)
      return Promise.resolve(undefined)
    })
    const onChunk = vi.fn()
    const onToolStart = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    const stream = desktopApi.chat.stream(
      'provider-1',
      'model-1',
      'session-1',
      { text: 'Hello' },
      { onChunk, onToolStart, onDone, onError },
      'C:\\workspace'
    )
    await stream.started

    const channel = tauriMocks.channels[0]
    expect(channel).toBeDefined()
    const streamId = tauriMocks.invoke.mock.calls.find(([command]) => command === 'chat_stream_start')?.[1]
      ?.request.streamId as string
    channel.onmessage?.({
      version: 1,
      runId: streamId,
      sequence: 0,
      kind: 'delta',
      payload: { delta: 'Hello', reasoningDelta: 'Thinking' }
    })
    channel.onmessage?.({
      version: 1,
      runId: streamId,
      sequence: 1,
      kind: 'toolCalls',
      payload: {
        calls: [{
          id: 'tool-1',
          function: { name: 'read_file', arguments: '{"path":"src/lib.rs"}' }
        }]
      }
    })
    channel.onmessage?.({
      version: 1,
      runId: streamId,
      sequence: 2,
      kind: 'completed',
      payload: { fullContent: 'Hello', stopReason: 'stop', txId: 'tx-1' }
    })

    expect(onChunk).toHaveBeenCalledWith('Hello', 'Thinking')
    expect(onToolStart).toHaveBeenCalledWith('tool-1', 'read_file', '{"path":"src/lib.rs"}', undefined)
    expect(onDone).toHaveBeenCalledWith('Hello', 'stop', 'tx-1')
    expect(onError).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(tauriMocks.invoke).toHaveBeenCalledWith('chat_stream_ack', {
      runId: streamId, sequence: 2
    }))
    await vi.waitFor(() => expect(tauriMocks.unlisten).toHaveBeenCalledTimes(2))
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith('chat_stream_stop', expect.anything())
  })

  it('exposes a retained transaction when a Tauri chat run fails', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    tauriMocks.invoke.mockImplementation((command: string, args?: { request?: { streamId?: string } }) => {
      if (command === 'chat_stream_start') return Promise.resolve(args?.request?.streamId)
      return Promise.resolve(undefined)
    })
    const onError = vi.fn()
    const stream = desktopApi.chat.stream(
      'provider-1',
      'model-1',
      'session-1',
      { text: 'Hello' },
      { onChunk: vi.fn(), onDone: vi.fn(), onError },
      'C:\\workspace'
    )
    await stream.started
    const streamId = tauriMocks.invoke.mock.calls.find(([command]) => command === 'chat_stream_start')?.[1]
      ?.request.streamId as string

    tauriMocks.channels[0].onmessage?.({
      version: 1,
      runId: streamId,
      sequence: 0,
      kind: 'failed',
      payload: { error: { message: 'Provider failed' }, providerCode: 'NETWORK', txId: 'tx-failed' }
    })

    expect(onError).toHaveBeenCalledWith('Provider failed', 'tx-failed')
    await vi.waitFor(() => expect(tauriMocks.invoke).toHaveBeenCalledWith('chat_stream_ack', {
      runId: streamId, sequence: 0
    }))
  })

  it('delivers and acknowledges typed context lifecycle frames', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    tauriMocks.invoke.mockImplementation((command: string, args?: { request?: { streamId?: string } }) => {
      if (command === 'chat_stream_start') return Promise.resolve(args?.request?.streamId)
      return Promise.resolve(undefined)
    })
    const onContextBudget = vi.fn()
    const onCompactionStarted = vi.fn()
    const onCompactionCompleted = vi.fn()
    const onCompactionFailed = vi.fn()
    const stream = desktopApi.chat.stream(
      'provider-1',
      'model-1',
      'session-1',
      { text: 'Hello' },
      {
        onChunk: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        onContextBudget,
        onCompactionStarted,
        onCompactionCompleted,
        onCompactionFailed
      }
    )
    await stream.started
    const streamId = tauriMocks.invoke.mock.calls.find(([command]) => command === 'chat_stream_start')?.[1]
      ?.request.streamId as string
    const channel = tauriMocks.channels[0]
    const budget = {
      hardInputLimit: 1000,
      usableInputBudget: 900,
      outputReserveTokens: 50,
      safetyMarginTokens: 50,
      systemPromptTokens: 0,
      toolSchemaTokens: 0,
      instructionTokens: 0,
      protocolTokens: 4,
      summaryTokens: 0,
      recentHistoryTokens: 100,
      rawHistoryTokens: 100,
      currentInputTokens: 10,
      totalInputTokens: 114,
      providerAdjustmentTokens: 0,
      pressureLevel: 'normal',
      estimateSource: 'heuristic',
      historyVersion: 2
    }
    const started = { trigger: 'auto_threshold', tokensBefore: 850, historyVersion: 2 }
    const completed = {
      trigger: 'auto_threshold', tokensBefore: 850, tokensAfter: 300, historyVersion: 4
    }
    const failed = {
      trigger: 'provider_overflow',
      errorCode: 'COMPACTION_SUMMARY_FAILED',
      message: 'Summary failed',
      retryable: true,
      historyVersion: 5
    }

    channel.onmessage?.({
      version: 1, runId: streamId, sequence: 0, kind: 'contextBudget', payload: budget
    })
    channel.onmessage?.({
      version: 1, runId: streamId, sequence: 1, kind: 'contextCompactionStarted', payload: started
    })
    channel.onmessage?.({
      version: 1, runId: streamId, sequence: 2, kind: 'contextCompactionCompleted', payload: completed
    })
    channel.onmessage?.({
      version: 1, runId: streamId, sequence: 3, kind: 'contextCompactionFailed', payload: failed
    })

    expect(onContextBudget).toHaveBeenCalledWith(budget)
    expect(onCompactionStarted).toHaveBeenCalledWith(started)
    expect(onCompactionCompleted).toHaveBeenCalledWith(completed)
    expect(onCompactionFailed).toHaveBeenCalledWith(failed)
    await vi.waitFor(() => expect(tauriMocks.invoke).toHaveBeenCalledWith('chat_stream_ack', {
      runId: streamId, sequence: 3
    }))
  })

  it('exposes a retained transaction when a Tauri chat run is interrupted', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    tauriMocks.invoke.mockImplementation((command: string, args?: { request?: { streamId?: string } }) => {
      if (command === 'chat_stream_start') return Promise.resolve(args?.request?.streamId)
      return Promise.resolve(undefined)
    })
    const onError = vi.fn()
    const stream = desktopApi.chat.stream(
      'provider-1',
      'model-1',
      'session-1',
      { text: 'Hello' },
      { onChunk: vi.fn(), onDone: vi.fn(), onError },
      'C:\\workspace'
    )
    await stream.started
    const streamId = tauriMocks.invoke.mock.calls.find(([command]) => command === 'chat_stream_start')?.[1]
      ?.request.streamId as string

    tauriMocks.channels[0].onmessage?.({
      version: 1,
      runId: streamId,
      sequence: 0,
      kind: 'interrupted',
      payload: { reason: 'Stopped by user', txId: 'tx-interrupted' }
    })

    expect(onError).toHaveBeenCalledWith('Stopped by user', 'tx-interrupted')
    await vi.waitFor(() => expect(tauriMocks.invoke).toHaveBeenCalledWith('chat_stream_ack', {
      runId: streamId, sequence: 0
    }))
  })

})
