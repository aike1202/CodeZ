import { Channel, invoke } from '@tauri-apps/api/core'

import type {
  DesktopEvent,
  FileContent,
  FileTreeNode,
  HealthResponse,
  ProjectInfo,
  SystemProbeEvent,
  ThemeInfo,
  ThemeSource,
  WindowAction,
  WorkspaceInfo,
  WorkspacePathItem
} from './generated/contracts'
import { normalizeDesktopError } from './errors'

async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(name, args)
  } catch (error) {
    throw normalizeDesktopError(error)
  }
}

export interface DesktopApi {
  system: {
    health(): Promise<HealthResponse>
    probe(): Promise<Array<DesktopEvent<SystemProbeEvent>>>
  }
  window: {
    control(action: WindowAction): Promise<void>
    openExternal(target: string): Promise<void>
  }
  workspace: {
    openDirectory(): Promise<string | null>
    scanFileTree(rootPath: string): Promise<FileTreeNode[]>
    getAllPaths(rootPath: string): Promise<WorkspacePathItem[]>
    readFile(filePath: string, rootPath: string): Promise<FileContent>
    detectProject(rootPath: string): Promise<ProjectInfo>
    getRecentProjects(): Promise<WorkspaceInfo[]>
    addRecentProject(project: WorkspaceInfo): Promise<void>
    removeRecentProject(id: string): Promise<void>
    renameRecentProject(id: string, newName: string): Promise<void>
  }
  theme: {
    get(): Promise<ThemeInfo>
    set(source: ThemeSource): Promise<ThemeInfo>
  }
}

export const desktopApi: DesktopApi = {
  system: {
    health: () => command('system_health'),
    probe: () => new Promise((resolve, reject) => {
      const received: Array<DesktopEvent<SystemProbeEvent>> = []
      const events = new Channel<DesktopEvent<SystemProbeEvent>>()
      let commandCompleted = false
      const timeout = window.setTimeout(() => {
        reject(new Error('Desktop channel probe timed out'))
      }, 5_000)
      const finish = (): void => {
        if (!commandCompleted || received.length !== 3) return
        window.clearTimeout(timeout)
        resolve(received)
      }
      events.onmessage = (event) => {
        if (received.length < 3) received.push(event)
        finish()
      }
      void command<void>('system_probe_channel', { events }).then(() => {
        commandCompleted = true
        finish()
      }).catch((error) => {
        window.clearTimeout(timeout)
        reject(error)
      })
    })
  },
  window: {
    control: (action) => command('window_control', { action }),
    openExternal: (target) => command('open_external', { target })
  },
  workspace: {
    openDirectory: () => command('workspace_open_directory'),
    scanFileTree: (rootPath) => command('workspace_scan_file_tree', { rootPath }),
    getAllPaths: (rootPath) => command('workspace_get_all_paths', { rootPath }),
    readFile: (filePath, rootPath) => command('workspace_read_file', { filePath, rootPath }),
    detectProject: (rootPath) => command('workspace_detect_project', { rootPath }),
    getRecentProjects: () => command('workspace_get_recent_projects'),
    addRecentProject: (project) => command('workspace_add_recent_project', { project }),
    removeRecentProject: (id) => command('workspace_remove_recent_project', { id }),
    renameRecentProject: (id, newName) => command('workspace_rename_recent_project', { id, newName })
  },
  theme: {
    get: () => command('theme_get'),
    set: (source) => command('theme_set', { source })
  }
}
