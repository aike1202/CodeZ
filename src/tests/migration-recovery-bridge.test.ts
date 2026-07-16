import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
  Channel: class<T> {
    onmessage?: (message: T) => void
  },
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: tauriMocks.listen,
}))

import { tauriBridge } from '../renderer/src/adapters/tauriBridge'

describe('migration recovery Tauri bridge', () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset()
    tauriMocks.listen.mockReset()
  })

  it('maps redacted status, credential submission, and restart to the recovery commands', async () => {
    const awaiting = {
      phase: 'awaitingCredentials',
      requirements: [{
        dataSet: 'providers',
        sourceIndex: 0,
        credentialId: 'provider-api-key:provider-1',
        reason: 'authenticationFailed',
        canReenter: true,
      }],
    }
    tauriMocks.invoke
      .mockResolvedValueOnce(awaiting)
      .mockResolvedValueOnce({ phase: 'readyToRestart', requirements: [] })
      .mockResolvedValueOnce(undefined)

    const status = await tauriBridge.migration.getStatus()
    const resumed = await tauriBridge.migration.submitCredentials([{
      credentialId: 'provider-api-key:provider-1',
      secret: 'fixture-secret',
    }])
    await tauriBridge.migration.restart()

    expect(status).toEqual(awaiting)
    expect(resumed).toEqual({ phase: 'readyToRestart', requirements: [] })
    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['migration_get_status'],
      ['migration_submit_credentials', {
        inputs: [{
          credentialId: 'provider-api-key:provider-1',
          secret: 'fixture-secret',
        }],
      }],
      ['migration_restart'],
    ])
  })
})
