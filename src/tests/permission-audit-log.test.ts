import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { PermissionAuditLog } from '../main/services/permission/PermissionAuditLog'

describe('PermissionAuditLog', () => {
  it('redacts credentials before writing JSONL', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-audit-'))
    const file = path.join(dir, 'audit.jsonl')
    try {
      await new PermissionAuditLog(file).append({ command: 'curl -H "Authorization: Bearer secret" https://example.test', decision: 'ask' })
      const content = await readFile(file, 'utf8')
      expect(content).not.toContain('secret')
      expect(content).toContain('[REDACTED]')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
