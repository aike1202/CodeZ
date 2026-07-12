import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import { SubAgentManager } from '../agent/SubAgentManager'
import { getSettingsService } from './settings.handlers'
import { getProviderService } from './provider.handlers'
import type {
  SubAgentInfo,
  SubAgentDetail,
  SubAgentModelSelection
} from '../../shared/types/subagent'

/** 把 disabledSubAgents 列表同步到 SubAgentManager */
export function syncDisabledSubAgents(): void {
  const settings = getSettingsService().getSettings()
  SubAgentManager.setDisabledTypes(settings.disabledSubAgents || [])
  SubAgentManager.setConfiguredModels(settings.subAgentModels || {})
}

export function registerSubAgentIpc(): void {
  ipcMain.handle(IPC_CHANNELS.SUBAGENT_LIST, async (): Promise<SubAgentInfo[]> => {
    const configuredModels = getSettingsService().getSettings().subAgentModels || {}
    return SubAgentManager.listDefinitions().map((def) => ({
      type: def.type,
      description: def.description,
      whenToUse: def.whenToUse,
      costHint: def.costHint,
      enabled: SubAgentManager.isEnabled(def.type),
      configuredModels: configuredModels[def.type]
    }))
  })

  ipcMain.handle(
    IPC_CHANNELS.SUBAGENT_TOGGLE,
    async (_event, type: string, enabled: boolean): Promise<void> => {
      const svc = getSettingsService()
      const current = new Set(svc.getSettings().disabledSubAgents || [])
      if (enabled) {
        current.delete(type)
      } else {
        current.add(type)
      }
      await svc.saveSettings({ disabledSubAgents: Array.from(current) })
      SubAgentManager.setDisabledTypes(Array.from(current))
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SUBAGENT_GET_DETAIL,
    async (_event, type: string): Promise<SubAgentDetail | null> => {
      const detail = await SubAgentManager.getDetail(type)
      if (!detail) return null
      const configuredModels = getSettingsService().getSettings().subAgentModels?.[type]
      return { ...detail, configuredModels }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SUBAGENT_SET_MODEL,
    async (
      _event,
      type: string,
      selections: SubAgentModelSelection[]
    ): Promise<void> => {
      if (!SubAgentManager.getDefinition(type)) {
        throw new Error(`Unknown subagent type '${type}'.`)
      }
      for (const selection of selections) {
        const provider = getProviderService().getConfig(selection.providerId)
        const modelExists = provider?.models.some((model) => model.name === selection.model)
        if (!provider || !modelExists) {
          throw new Error('The selected subagent model is not available.')
        }
      }

      const svc = getSettingsService()
      const models = { ...(svc.getSettings().subAgentModels || {}) }
      if (selections.length > 0) models[type] = selections
      else delete models[type]
      await svc.saveSettings({ subAgentModels: models })
      SubAgentManager.setConfiguredModels(models)
    }
  )
}
