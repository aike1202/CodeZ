import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import { SubAgentManager } from '../agent/SubAgentManager'
import { getSettingsService } from './settings.handlers'
import type { SubAgentInfo, SubAgentDetail } from '../../shared/types/subagent'

/** 把 disabledSubAgents 列表同步到 SubAgentManager */
export function syncDisabledSubAgents(): void {
  const settings = getSettingsService().getSettings()
  SubAgentManager.setDisabledTypes(settings.disabledSubAgents || [])
}

export function registerSubAgentIpc(): void {
  ipcMain.handle(IPC_CHANNELS.SUBAGENT_LIST, async (): Promise<SubAgentInfo[]> => {
    return SubAgentManager.listDefinitions().map((def) => ({
      type: def.type,
      description: def.description,
      whenToUse: def.whenToUse,
      costHint: def.costHint,
      enabled: SubAgentManager.isEnabled(def.type)
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
      return SubAgentManager.getDetail(type) ?? null
    }
  )
}
