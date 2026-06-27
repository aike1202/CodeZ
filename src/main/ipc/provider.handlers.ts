import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import { ProviderService } from '../services/ProviderService'
import type { ProviderInfo, ProviderFormData, ConnectionTestResult } from '../../shared/types/provider'

let providerService: ProviderService | null = null

export function getProviderService(): ProviderService {
  if (!providerService) {
    providerService = new ProviderService()
    providerService.load()
  }
  return providerService
}

export function registerProviderIpc(): void {
  const svc = getProviderService()

  ipcMain.handle(IPC_CHANNELS.PROVIDER_LIST, async (): Promise<ProviderInfo[]> => {
    return svc.getAll()
  })

  ipcMain.handle(IPC_CHANNELS.PROVIDER_ADD, async (_event, form: ProviderFormData): Promise<ProviderInfo> => {
    const config = await svc.add(form)
    return {
      id: config.id,
      name: config.name,
      baseUrl: config.baseUrl,
      apiKeyMasked: '****',
      models: config.models,
      thinking: config.thinking,
      enabled: config.enabled,
      createdAt: config.createdAt
    }
  })

  ipcMain.handle(IPC_CHANNELS.PROVIDER_UPDATE, async (_event, id: string, form: Partial<ProviderFormData>): Promise<ProviderInfo | null> => {
    const config = await svc.update(id, form)
    if (!config) return null
    const all = svc.getAll()
    return all.find((p) => p.id === id) || null
  })

  ipcMain.handle(IPC_CHANNELS.PROVIDER_REMOVE, async (_event, id: string): Promise<boolean> => {
    return svc.remove(id)
  })

  ipcMain.handle(IPC_CHANNELS.PROVIDER_TEST, async (_event, id: string): Promise<ConnectionTestResult> => {
    return svc.testConnection(id)
  })

  ipcMain.handle(IPC_CHANNELS.PROVIDER_SET_ACTIVE, async (_event, id: string): Promise<void> => {
    return svc.setActive(id)
  })
}
