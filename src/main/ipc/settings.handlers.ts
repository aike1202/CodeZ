import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import { SettingsService } from '../services/SettingsService'
import type { GeneralSettings } from '../../shared/types/settings'

let settingsService: SettingsService | null = null

export function getSettingsService(): SettingsService {
  if (!settingsService) {
    settingsService = new SettingsService()
  }
  return settingsService
}

export function registerSettingsIpc(): void {
  const svc = getSettingsService()

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async (): Promise<GeneralSettings> => {
    return svc.getSettings()
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SAVE, async (_event, settings: Partial<GeneralSettings>): Promise<GeneralSettings> => {
    return svc.saveSettings(settings)
  })
}
