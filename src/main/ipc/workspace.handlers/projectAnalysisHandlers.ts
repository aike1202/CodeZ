import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../../shared/ipc/channels'
import { WorkspaceService } from '../../services/WorkspaceService'
import { RecentProjectsStore } from '../../services/RecentProjectsStore'
import type { WorkspaceInfo } from '../../../shared/types/workspace'

let recentStore: RecentProjectsStore | null = null

export function getRecentStore(): RecentProjectsStore {
  if (!recentStore) {
    recentStore = new RecentProjectsStore()
    recentStore.load()
  }
  return recentStore
}

export function registerProjectAnalysisHandlers(): void {
  const store = getRecentStore()

  ipcMain.handle(IPC_CHANNELS.DETECT_PROJECT, async (_event, rootPath: string) => {
    try {
      const service = new WorkspaceService(rootPath)
      return await service.detectProjectType()
    } catch (error) {
      return { type: 'unknown' }
    }
  })

  ipcMain.handle(IPC_CHANNELS.GET_RECENT_PROJECTS, async (): Promise<WorkspaceInfo[]> => {
    return store.getAll()
  })

  ipcMain.handle(
    IPC_CHANNELS.ADD_RECENT_PROJECT,
    async (_event, project: WorkspaceInfo): Promise<void> => {
      await store.add(project)
    }
  )

  ipcMain.handle(IPC_CHANNELS.REMOVE_RECENT_PROJECT, async (_event, id: string): Promise<void> => {
    await store.remove(id)
  })

  ipcMain.handle(
    IPC_CHANNELS.UPDATE_PROJECT,
    async (_event, project: WorkspaceInfo): Promise<void> => {
      await store.updateProject(project)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.RENAME_RECENT_PROJECT,
    async (_event, id: string, newName: string): Promise<void> => {
      await store.rename(id, newName)
    }
  )
}
