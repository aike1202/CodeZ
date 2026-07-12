import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'

const electronState = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => electronState.userData },
}))

import { SettingsService } from '../main/services/SettingsService'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('SubAgent model settings migration', () => {
  it('normalizes a legacy single-model selection into an ordered candidate list', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-subagent-model-migration-'))
    roots.push(root)
    electronState.userData = root
    await writeFile(path.join(root, 'settings.json'), JSON.stringify({
      subAgentModels: {
        Explore: { providerId: 'provider-1', model: 'fast-model' }
      }
    }))

    const service = new SettingsService()
    await service.init()

    expect(service.getSettings().subAgentModels).toEqual({
      Explore: [{ providerId: 'provider-1', model: 'fast-model' }]
    })
  })
})
