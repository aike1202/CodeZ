import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import type { McpServerConfig } from '../services/mcp'
import { getMcpConnectionManager } from '../services/mcp'
import { McpSecretStore } from '../services/mcp'
import { getWorkspaceService } from './workspace.handlers'

export function registerMcpIpc(): void {
  const manager = getMcpConnectionManager()
  const secrets = new McpSecretStore()
  manager.onChanged(() => {
    const statuses = manager.getStatuses()
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC_CHANNELS.MCP_CHANGED, statuses)
    }
  })

  ipcMain.handle(IPC_CHANNELS.MCP_LIST, async () => {
    await manager.syncWorkspace(getWorkspaceService()?.getCurrentWorkspace() || undefined)
    return { configs: await manager.getConfiguration(), statuses: manager.getStatuses() }
  })
  ipcMain.handle(IPC_CHANNELS.MCP_SAVE_USER, async (_event, servers: Record<string, McpServerConfig>) => {
    await manager.saveUserServers(servers)
    return { configs: await manager.getConfiguration(), statuses: manager.getStatuses() }
  })
  ipcMain.handle(IPC_CHANNELS.MCP_SET_ENABLED, async (_event, name: string, enabled: boolean) => {
    await manager.setUserServerEnabled(name, enabled)
    return { configs: await manager.getConfiguration(), statuses: manager.getStatuses() }
  })
  ipcMain.handle(IPC_CHANNELS.MCP_GET_CATALOG, (_event, name: string) => manager.getCatalog(name))
  ipcMain.handle(IPC_CHANNELS.MCP_RECONNECT, async (_event, name: string) => {
    await manager.reconnect(name)
    return manager.getStatuses()
  })
  ipcMain.handle(IPC_CHANNELS.MCP_AUTHORIZE, async (_event, name: string) => {
    await manager.authorize(name)
    return manager.getStatuses()
  })
  ipcMain.handle(IPC_CHANNELS.MCP_LOGOUT, async (_event, name: string) => {
    await manager.logout(name)
    return manager.getStatuses()
  })
  ipcMain.handle(IPC_CHANNELS.MCP_TRUST_PROJECT, async (_event, fingerprint: string) => {
    await manager.trustProject(fingerprint)
    return { configs: await manager.getConfiguration(), statuses: manager.getStatuses() }
  })
  ipcMain.handle(IPC_CHANNELS.MCP_SECRET_KEYS, () => secrets.listKeys())
  ipcMain.handle(IPC_CHANNELS.MCP_SECRET_SET, async (_event, key: string, value: string) => {
    await secrets.set(key, value)
    await manager.refreshResolvedSecrets()
    return secrets.listKeys()
  })
  ipcMain.handle(IPC_CHANNELS.MCP_SECRET_DELETE, async (_event, key: string) => {
    await secrets.delete(key)
    await manager.refreshResolvedSecrets()
    return secrets.listKeys()
  })
}
