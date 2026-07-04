import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import { SessionStore } from '../services/SessionStore'

let sessionStore: SessionStore | null = null

export function getSessionStore(): SessionStore {
  if (!sessionStore) {
    sessionStore = new SessionStore()
    sessionStore.load()
  }
  return sessionStore
}

export function registerSessionIpc(): void {
  const svc = getSessionStore()

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => {
    return svc.getAll()
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_GET, async (_event, sessionId: string) => {
    return svc.get(sessionId) || null
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_SAVE, async (_event, session) => {
    await svc.save(session)
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_event, sessionId: string) => {
    await svc.delete(sessionId)
  })
}
