import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { app } from 'electron'

export type ToolJournalEventName =
  | 'catalog.snapshot.created'
  | 'exposure.plan.created'
  | 'tool.call.received'
  | 'tool.call.validation_failed'
  | 'tool.call.permission_started'
  | 'tool.call.permission_decided'
  | 'tool.call.queued'
  | 'tool.call.started'
  | 'tool.call.completed'
  | 'tool.call.failed'
  | 'tool.call.cancelled'
  | 'tool.result.persisted'
  | 'tool.batch.completed'

export interface ToolJournalIdentity {
  sessionId?: string
  turnId?: string
  contextScopeId?: string
  providerId?: string
  model?: string
  apiFormat?: string
  catalogSnapshotId?: string
  exposurePlanId?: string
  schemaFingerprint?: string
}

export interface ToolJournalEvent extends ToolJournalIdentity {
  event: ToolJournalEventName
  timestamp?: string
  callId?: string
  toolName?: string
  source?: string
  descriptorVersion?: string
  status?: string
  decision?: string
  errorCode?: string
  recoverable?: boolean
  inputBytes?: number
  resultBytes?: number
  modelResultBytes?: number
  persistedBytes?: number
  resourceKeyCount?: number
  wave?: number
  queueDurationMs?: number
  executionDurationMs?: number
  hookDurationMs?: number
  batchSize?: number
  permissionRuleId?: string
  permissionMode?: string
}

function defaultPath(): string {
  try {
    if (app?.getPath) return path.join(app.getPath('userData'), 'tool-execution-journal.jsonl')
  } catch {}
  return path.join(os.tmpdir(), `codez-tool-journal-${process.pid}.jsonl`)
}

export class ToolExecutionJournal {
  private writeQueue: Promise<void> = Promise.resolve()
  constructor(
    private readonly filePath = defaultPath(),
    private readonly retention = { maxBytes: 10 * 1024 * 1024, maxFiles: 5, maxAgeMs: 30 * 24 * 60 * 60 * 1000 }
  ) {}

  private async rotateIfNeeded(nextBytes: number): Promise<void> {
    let size = 0
    try { size = (await fs.stat(this.filePath)).size } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (size + nextBytes <= this.retention.maxBytes) return
    for (let index = this.retention.maxFiles - 1; index >= 1; index--) {
      const source = index === 1 ? this.filePath : `${this.filePath}.${index - 1}`
      const destination = `${this.filePath}.${index}`
      await fs.rm(destination, { force: true }).catch(() => undefined)
      await fs.rename(source, destination).catch((error: any) => {
        if (error?.code !== 'ENOENT') throw error
      })
    }
  }

  private async removeExpired(): Promise<void> {
    const cutoff = Date.now() - this.retention.maxAgeMs
    for (let index = 1; index < this.retention.maxFiles; index++) {
      const candidate = `${this.filePath}.${index}`
      try {
        if ((await fs.stat(candidate)).mtimeMs < cutoff) await fs.rm(candidate, { force: true })
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }

  append(event: ToolJournalEvent): Promise<void> {
    const safeEvent = { ...event, timestamp: event.timestamp || new Date().toISOString() }
    const line = `${JSON.stringify(safeEvent)}\n`
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      await this.rotateIfNeeded(Buffer.byteLength(line, 'utf8'))
      await this.removeExpired()
      await fs.appendFile(this.filePath, line, { encoding: 'utf8', mode: 0o600 })
    })
    this.writeQueue = operation.then(() => undefined, () => undefined)
    return operation
  }
}

let sharedJournal: ToolExecutionJournal | undefined
export function getToolExecutionJournal(): ToolExecutionJournal {
  if (!sharedJournal) sharedJournal = new ToolExecutionJournal()
  return sharedJournal
}
