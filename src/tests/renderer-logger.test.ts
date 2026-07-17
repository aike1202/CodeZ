import { describe, expect, it, vi } from 'vitest'

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
import { logger } from '../renderer/src/utils/logger'

describe('renderer logger', () => {
  it('preserves console arguments while omitting structured values from the desktop payload', () => {
    const desktopLog = vi.spyOn(desktopApi.logger, 'info').mockResolvedValue(undefined)
    const consoleLog = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const structuredValue = { apiKey: 'must-not-cross-the-webview-boundary' }

    logger.info('renderer ready', structuredValue, 42)

    expect(desktopLog).toHaveBeenCalledWith('renderer ready [non-text value omitted] 42')
    expect(consoleLog).toHaveBeenCalledWith('renderer ready', structuredValue, 42)
    desktopLog.mockRestore()
    consoleLog.mockRestore()
  })

  it('limits the desktop payload to four KiB without changing console output', () => {
    const desktopLog = vi.spyOn(desktopApi.logger, 'debug').mockResolvedValue(undefined)
    const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const source = 'x'.repeat(5_000)

    logger.debug(source)

    const message = desktopLog.mock.calls[0]?.[0] ?? ''
    expect(new TextEncoder().encode(message).length).toBeLessThanOrEqual(4 * 1024)
    expect(consoleDebug).toHaveBeenCalledWith(source)
    desktopLog.mockRestore()
    consoleDebug.mockRestore()
  })
})
