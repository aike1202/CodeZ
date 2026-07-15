import { app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'

function redact(value: string): string {
  return value
    .replace(/("(?:api[_-]?key|token|password|secret)"\s*:\s*")[^"]*/gi, '$1[REDACTED]')
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)\S+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s"']+/gi, '$1[REDACTED]')
}

export class PermissionAuditLog {
  constructor(private readonly filePath = app?.getPath ? path.join(app.getPath('userData'), 'permission-audit.jsonl') : ':memory:') {}

  async append(event: Record<string, unknown>): Promise<void> {
    if (this.filePath === ':memory:') return
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      const safe = JSON.parse(redact(JSON.stringify({ timestamp: new Date().toISOString(), ...event })))
      await fs.appendFile(this.filePath, `${JSON.stringify(safe)}\n`, 'utf8')
    } catch {}
  }
}

let instance: PermissionAuditLog | null = null
export function getPermissionAuditLog(): PermissionAuditLog {
  if (!instance) instance = new PermissionAuditLog()
  return instance
}
