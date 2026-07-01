import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import { TaskStore, TaskData } from '../services/TaskStore'

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

export function notifyTaskUpsert(task: TaskData): void {
  const wins = BrowserWindow.getAllWindows()
  for (const win of wins) {
    win.webContents.send(IPC_CHANNELS.TASK_UPSERT, task)
  }
}

export function notifyTaskSync(sessionId: string): void {
  const store = getTaskStore()
  const tasks = store.getBySession(sessionId)
  const wins = BrowserWindow.getAllWindows()
  for (const win of wins) {
    win.webContents.send(IPC_CHANNELS.TASK_SYNC, { sessionId, tasks })
  }
}
