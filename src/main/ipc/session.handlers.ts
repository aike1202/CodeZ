import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import { SessionStore } from '../services/SessionStore'
import { deleteSessionWithAttachments, getAttachmentService } from './attachment.handlers'
import { getReadFingerprintStore } from '../tools/ReadFingerprintStore'
import { getEditTransactionService } from '../services/EditTransactionService'
import { getLargeToolResultStore } from '../tools/runtime/LargeToolResultStore'
import { getToolExposureState } from '../tools/runtime/ToolExposurePlanner'
import { getWorkspaceService } from './workspace.handlers'
import { getMcpContentStore } from '../services/mcp'
import { getAgentCollaborationRuntime } from '../services/agents'

let sessionStore: SessionStore | null = null
let loadPromise: Promise<void> | null = null

async function loadSessionStore(store: SessionStore): Promise<void> {
  await store.load()
  const exposureState = getToolExposureState()
  for (const session of store.getAll()) {
    if (session.isDeleted) continue
    exposureState.restoreSession(
      session.id,
      session.toolRuntime?.activatedDeferredTools
    )
  }
}

export async function initializeSessionStore(): Promise<SessionStore> {
  if (!sessionStore) sessionStore = new SessionStore()
  if (!loadPromise) loadPromise = loadSessionStore(sessionStore)
  await loadPromise
  return sessionStore
}

export async function getSessionStoreReady(): Promise<SessionStore> {
  return initializeSessionStore()
}

export function getSessionStore(): SessionStore {
  if (!sessionStore) {
    sessionStore = new SessionStore()
    loadPromise = loadSessionStore(sessionStore)
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
    if (permanentlyDeleted) {
      await getEditTransactionService().cleanupSession(sessionId)
      const workspaceRoot = getWorkspaceService()?.getCurrentWorkspace()
      if (workspaceRoot) {
        await Promise.all([
          getLargeToolResultStore().removeSession(workspaceRoot, sessionId),
          getMcpContentStore().removeSession(workspaceRoot, sessionId)
        ])
      }
      getToolExposureState().clearSession(sessionId)
      getAgentCollaborationRuntime().removeSession(sessionId)
    }
    getReadFingerprintStore().clear(sessionId)
  })
}
