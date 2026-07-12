import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import { SessionStore } from '../services/SessionStore'
import { deleteSessionWithAttachments, getAttachmentService } from './attachment.handlers'
import { getReadFingerprintStore } from '../tools/ReadFingerprintStore'
import { getEditTransactionService } from '../services/EditTransactionService'

let sessionStore: SessionStore | null = null
let loadPromise: Promise<void> | null = null

export async function initializeSessionStore(): Promise<SessionStore> {
  if (!sessionStore) sessionStore = new SessionStore()
  if (!loadPromise) loadPromise = sessionStore.load()
  await loadPromise
  return sessionStore
}

export async function getSessionStoreReady(): Promise<SessionStore> {
  return initializeSessionStore()
}

export function getSessionStore(): SessionStore {
  if (!sessionStore) {
    sessionStore = new SessionStore()
    loadPromise = sessionStore.load()
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
    const permanentlyDeleted = await deleteSessionWithAttachments(svc, getAttachmentService(), sessionId)
    if (permanentlyDeleted) await getEditTransactionService().cleanupSession(sessionId)
    getReadFingerprintStore().clear(sessionId)
  })
}
