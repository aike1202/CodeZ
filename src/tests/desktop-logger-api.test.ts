import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
  Channel: class<T> {
    onmessage?: (message: T) => void
  }
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
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

describe('desktop renderer logging adapter', () => {
  beforeEach(() => {
    originalWindow = (globalThis as { window?: unknown }).window
    tauriMocks.invoke.mockReset()
    tauriMocks.invoke.mockResolvedValue(undefined)
  })

  afterEach(() => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window')
      return
    }
    setWindow(originalWindow)
  })

  it('maps each typed renderer log level to the bounded Tauri command', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })

    await desktopApi.logger.debug('debug message')
    await desktopApi.logger.info('info message')
    await desktopApi.logger.warn('warn message')
    await desktopApi.logger.error('error message')

    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['renderer_log', { level: 'debug', message: 'debug message' }],
      ['renderer_log', { level: 'info', message: 'info message' }],
      ['renderer_log', { level: 'warn', message: 'warn message' }],
      ['renderer_log', { level: 'error', message: 'error message' }]
    ])
  })

  it('uses the frozen Electron logger when Tauri is unavailable', async () => {
    const electronLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    }
    setWindow({ api: { logger: electronLogger } })

    await desktopApi.logger.warn('Electron fallback')

    expect(tauriMocks.invoke).not.toHaveBeenCalled()
    expect(electronLogger.warn).toHaveBeenCalledWith('Electron fallback')
  })
})
