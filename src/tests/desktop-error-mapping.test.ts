import { describe, expect, it } from 'vitest'

import { normalizeDesktopError } from '../renderer/src/shared/desktop/errors'

describe('desktop error mapping', () => {
  it('preserves structured command errors from Tauri', () => {
    const error = normalizeDesktopError({
      code: 'TIMEOUT',
      message: 'The operation timed out',
      retryable: true,
      correlationId: 'cmd-0001'
    })

    expect(error).toMatchObject({
      name: 'DesktopCommandError',
      code: 'TIMEOUT',
      message: 'The operation timed out',
      retryable: true,
      correlationId: 'cmd-0001'
    })
  })

  it('parses serialized command errors without losing the stable code', () => {
    const error = normalizeDesktopError(JSON.stringify({
      code: 'PERMISSION_DENIED',
      message: 'Approval was denied',
      retryable: false,
      correlationId: null
    }))

    expect(error.code).toBe('PERMISSION_DENIED')
  })

  it('does not expose messages from unstructured errors', () => {
    const error = normalizeDesktopError(new Error('apiKey=secret-value'))

    expect(error).toMatchObject({
      code: 'INTERNAL',
      message: 'Desktop command failed',
      retryable: false,
      correlationId: null
    })
  })
})
