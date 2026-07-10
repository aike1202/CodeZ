import { app } from 'electron'
import * as path from 'path'
import * as os from 'os'
import { ModelLedgerStore } from './ModelLedgerStore'
import { SessionRuntimeCoordinator } from './SessionRuntimeCoordinator'

export interface ContextCoreServices {
  ledger: ModelLedgerStore
  coordinator: SessionRuntimeCoordinator
}

let singleton: ContextCoreServices | null = null

export function getContextCoreServices(userDataPath?: string): ContextCoreServices {
  if (singleton && !userDataPath) return singleton
  const basePath = userDataPath ?? (app?.getPath
    ? app.getPath('userData')
    : path.join(os.tmpdir(), `codez-context-${process.pid}`))
  const root = path.join(basePath, 'session-runtime')
  const ledger = new ModelLedgerStore(root)
  const services = { ledger, coordinator: new SessionRuntimeCoordinator(ledger) }
  if (!userDataPath) singleton = services
  return services
}
