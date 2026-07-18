import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
  Channel: class<T> {
    onmessage?: (message: T) => void
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

describe('desktop MCP adapter', () => {
  beforeEach(() => {
    originalWindow = (globalThis as { window?: unknown }).window
    tauriMocks.invoke.mockReset()
    tauriMocks.listen.mockReset()
  })

  afterEach(() => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window')
      return
    }
    setWindow(originalWindow)
  })

  it('maps OAuth, trust, subscriptions, project secret references, and reverse replies to Tauri commands', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    tauriMocks.invoke.mockResolvedValue(undefined)
    const root = 'C:/workspace'

    await desktopApi.mcp.authorize('remote', root)
    await desktopApi.mcp.logout('remote', root)
    await desktopApi.mcp.trustProject('fingerprint', root)
    await desktopApi.mcp.subscribeResource('remote', 'file:///notes', root)
    await desktopApi.mcp.unsubscribeResource('remote', 'file:///notes', root)
    await desktopApi.mcp.listSecretKeys(root)
    await desktopApi.mcp.respondReverseRequest('request-1', { kind: 'sampling', approved: false })

    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['mcp_authorize', { name: 'remote', workspaceRoot: root }],
      ['mcp_logout', { name: 'remote', workspaceRoot: root }],
      ['mcp_trust_project', { fingerprint: 'fingerprint', workspaceRoot: root }],
      ['mcp_subscribe_resource', { name: 'remote', uri: 'file:///notes', workspaceRoot: root }],
      ['mcp_unsubscribe_resource', { name: 'remote', uri: 'file:///notes', workspaceRoot: root }],
      ['mcp_list_secret_keys', { workspaceRoot: root }],
      ['mcp_respond_reverse_request', {
        requestId: 'request-1',
        response: { kind: 'sampling', approved: false }
      }]
    ])
  })

  it('delivers only valid reverse requests and disposes the Tauri listener', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    const dispose = vi.fn()
    let listener: ((event: { payload: unknown }) => void) | undefined
    tauriMocks.listen.mockImplementation((_name: string, callback: (event: { payload: unknown }) => void) => {
      listener = callback
      return Promise.resolve(dispose)
    })
    const received: unknown[] = []
    const stop = desktopApi.mcp.onReverseRequest((event) => received.push(event))

    listener?.({ payload: {
      requestId: 'request-1',
      serverName: 'remote',
      fingerprint: 'fingerprint',
      policy: 'ask',
      request: { kind: 'sampling', maxTokens: 64, messageCount: 2, hasSystemPrompt: false }
    } })
    listener?.({ payload: {
      requestId: 'request-2',
      serverName: 'remote',
      fingerprint: 'fingerprint',
      policy: 'deny',
      request: { kind: 'sampling', maxTokens: 64, messageCount: 2, hasSystemPrompt: false }
    } })
    stop()

    expect(received).toHaveLength(1)
    expect(tauriMocks.listen).toHaveBeenCalledWith('mcp:reverse-request', expect.any(Function))
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
  })

})
