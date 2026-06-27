import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import { TaskStore } from '../services/TaskStore'

let taskStore: TaskStore | null = null

export function getTaskStore(): TaskStore {
  if (!taskStore) {
    taskStore = new TaskStore()
    taskStore.load()
  }
  return taskStore
}

export function registerTaskIpc(): void {
  const svc = getTaskStore()

  ipcMain.handle(IPC_CHANNELS.TASK_GET_BY_PROJECT, async (_event, projectId: string) => {
    return svc.getAllByProject(projectId)
  })

  ipcMain.handle(IPC_CHANNELS.TASK_SAVE, async (_event, task) => {
    await svc.save(task)
  })

  ipcMain.handle(IPC_CHANNELS.TASK_DELETE, async (_event, taskId: string) => {
    await svc.delete(taskId)
  })
}
