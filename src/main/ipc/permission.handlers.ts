import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import type { PermissionMode } from '../../shared/types/permission'
import { getWorkspacePermissionStore } from '../services/permission/workspacePermissionStore'

export function registerPermissionIpc(): void {
  ipcMain.handle(IPC_CHANNELS.PERMISSION_MODE_GET, (_event, rootPath: string) =>
    getWorkspacePermissionStore().getMode(rootPath)
  )

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_MODE_SET,
    async (_event, rootPath: string, mode: PermissionMode): Promise<PermissionMode> => {
      if (mode !== 'auto' && mode !== 'full-access') return 'auto'
      await getWorkspacePermissionStore().setMode(rootPath, mode)
      return mode
    }
  )
}
