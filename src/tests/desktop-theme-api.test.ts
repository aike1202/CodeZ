import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  DesktopEvent,
  ThemeInfo
} from '../renderer/src/shared/desktop/generated/contracts'

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  listen: vi.fn(),
  unlisten: vi.fn()
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

const darkTheme: ThemeInfo = {
  shouldUseDarkColors: true,
  themeSource: 'dark'
}

const themeEvent: DesktopEvent<ThemeInfo> = {
  version: 1,
  streamId: null,
  sequence: null,
  kind: 'themeChanged',
  payload: darkTheme
}

let originalWindow: unknown

describe('desktop theme facade', () => {
  beforeEach(() => {
    originalWindow = (globalThis as { window?: unknown }).window
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI_INTERNALS__: {} },
      writable: true
    })
    tauriMocks.listeners.clear()
    tauriMocks.invoke.mockReset()
    tauriMocks.listen.mockReset()
    tauriMocks.unlisten.mockReset()
    tauriMocks.listen.mockImplementation(async (
      name: string,
      callback: (event: { payload: unknown }) => void
    ) => {
      tauriMocks.listeners.set(name, callback)
      return tauriMocks.unlisten
    })
  })

  afterEach(() => {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
    else Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
      writable: true
    })
  })

  it('unwraps the versioned Tauri event before notifying renderer consumers', async () => {
    const callback = vi.fn()
    const dispose = desktopApi.theme.onUpdated(callback)

    await vi.waitFor(() => {
      expect(tauriMocks.listeners.has('desktop://theme-changed')).toBe(true)
    })
    tauriMocks.listeners.get('desktop://theme-changed')?.({ payload: themeEvent })

    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(darkTheme)

    dispose()
    await vi.waitFor(() => {
      expect(tauriMocks.unlisten).toHaveBeenCalledOnce()
    })
  })
})
