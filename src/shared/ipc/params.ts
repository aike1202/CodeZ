import type { FileTreeNode, FileContent, ProjectInfo, WorkspaceInfo } from '../types/workspace'
import type { IPC_CHANNELS } from './channels'

export interface IpcParams {
  [IPC_CHANNELS.OPEN_DIRECTORY]: {
    request: void
    response: string | null
  }
  [IPC_CHANNELS.SCAN_FILE_TREE]: {
    request: string
    response: FileTreeNode[]
  }
  [IPC_CHANNELS.READ_FILE]: {
    request: string
    response: FileContent
  }
  [IPC_CHANNELS.DETECT_PROJECT]: {
    request: string
    response: ProjectInfo
  }
  [IPC_CHANNELS.GET_RECENT_PROJECTS]: {
    request: void
    response: WorkspaceInfo[]
  }
  [IPC_CHANNELS.ADD_RECENT_PROJECT]: {
    request: WorkspaceInfo
    response: void
  }
  [IPC_CHANNELS.REMOVE_RECENT_PROJECT]: {
    request: string
    response: void
  }
}
