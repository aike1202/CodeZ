import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn(),
  unlisten: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>()
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

describe('desktop terminal adapter', () => {
  beforeEach(() => {
    originalWindow = (globalThis as { window?: unknown }).window
    tauriMocks.invoke.mockClear()
    tauriMocks.unlisten.mockClear()
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

  it('maps terminal commands to Tauri with typed arguments', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })

    await desktopApi.terminal.start('term-1', 'C:\\workspace')
    await desktopApi.terminal.write('term-1', 'cargo test\r')
    await desktopApi.terminal.resize('term-1', 120, 40)
    await desktopApi.terminal.kill('term-1')

    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['terminal_start', { workspaceId: 'term-1', rootPath: 'C:\\workspace' }],
      ['terminal_write', { workspaceId: 'term-1', text: 'cargo test\r' }],
      ['terminal_resize', { workspaceId: 'term-1', cols: 120, rows: 40 }],
      ['terminal_kill', { workspaceId: 'term-1' }]
    ])
  })

  it('delivers valid output, acknowledges it, and disposes the asynchronous Tauri listener', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    const received = vi.fn()
    const exited = vi.fn()
    const unsubscribe = desktopApi.terminal.onOutput(received)
    const unsubscribeExit = desktopApi.terminal.onExit(exited)
    const listener = tauriMocks.listeners.get('terminal:output')
    const exitListener = tauriMocks.listeners.get('terminal:exit')
    expect(listener).toBeDefined()
    expect(exitListener).toBeDefined()

    listener?.({ payload: { id: 'term-1', sequence: 4, data: [228, 189, 160] } })
    exitListener?.({ payload: { id: 'term-1', exit_code: 7 } })
    await Promise.resolve()

    expect(received).toHaveBeenCalledWith({
      workspaceId: 'term-1',
      sequence: 4,
      data: new Uint8Array([228, 189, 160])
    })
    expect(exited).toHaveBeenCalledWith({ workspaceId: 'term-1', exitCode: 7 })
    expect(tauriMocks.invoke).toHaveBeenCalledWith('terminal_ack', {
      workspaceId: 'term-1',
      sequence: 4
    })

    unsubscribe()
    unsubscribeExit()
    await vi.waitFor(() => expect(tauriMocks.unlisten).toHaveBeenCalledTimes(2))

    listener?.({ payload: { id: 'term-1', sequence: 5, data: 'ignored' } })
    expect(received).toHaveBeenCalledOnce()
  })

  it('rejects malformed Tauri byte frames without acknowledging them', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    const received = vi.fn()
    desktopApi.terminal.onOutput(received)
    const listener = tauriMocks.listeners.get('terminal:output')

    listener?.({ payload: { id: 'term-1', sequence: 4, data: [256] } })
    await Promise.resolve()

    expect(received).not.toHaveBeenCalled()
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith('terminal_ack', expect.anything())
  })
})
