import { afterEach, describe, expect, it } from 'vitest'
import { access, mkdtemp, readFile, rm } from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { ToolExecutionJournal } from '../main/tools/runtime/ToolExecutionJournal'
import { ToolExecutionPipeline } from '../main/tools/runtime/ToolExecutionPipeline'
import { ToolRegistry } from '../main/tools/runtime/ToolRegistry'
import type { ToolHandler, ToolPipelineResult } from '../main/tools/runtime/types'
import { ToolResultProcessor } from '../main/tools/runtime/ToolResultProcessor'
import { LargeToolResultStore } from '../main/tools/runtime/LargeToolResultStore'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('ToolExecutionJournal', () => {
  it('records lifecycle metadata without arguments or result content', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-tool-journal-'))
    roots.push(root)
    const journalPath = path.join(root, 'journal.jsonl')
    const secret = 'SECRET_ARGUMENT_AND_RESULT'
    const handler = {
      descriptor: {
        name: 'JournalExample', aliases: [], version: 'v1', source: 'builtin', sourceId: 'test',
        summary: 'journal', description: 'journal', inputSchema: { type: 'object', additionalProperties: true },
        availability: { enabled: () => true, roles: '*', exposure: 'core' },
        behavior: { readOnly: () => true, destructive: () => false, concurrency: 'safe', interrupt: 'cancel', maxResultChars: 1000 },
        planEffects: async () => ({ effects: [{ kind: 'read-memory', path: 'opaque' }], analysisStatus: 'parsed' }),
        resourceKeys: async () => ['opaque:read']
      },
      execute: async () => ({ status: 'success' as const, data: secret, modelContent: secret })
    } as ToolHandler<Record<string, unknown>>
    const registry = new ToolRegistry(); registry.register(handler)
    const catalog = registry.createSnapshot({ platform: process.platform, agentRole: 'main' })
    const pipeline = new ToolExecutionPipeline({ journal: new ToolExecutionJournal(journalPath) })
    await pipeline.executeBatch([
      { callId: 'c1', position: 0, name: 'JournalExample', rawArguments: JSON.stringify({ value: secret }) }
    ], {
      catalog, workspaceRoot: root, sessionId: 's1', agentRole: 'main',
      journalIdentity: { sessionId: 's1', turnId: 't1', contextScopeId: 'main', providerId: 'p1', model: 'm1', apiFormat: 'openai' },
      authorize: async () => ({ allowed: true, requestId: 'p1' }),
      createToolContext: () => ({ workspaceRoot: root, sessionId: 's1' })
    })
    const raw = await readFile(journalPath, 'utf8')
    expect(raw).not.toContain(secret)
    const events = raw.trim().split('\n').map((line) => JSON.parse(line))
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining([
      'tool.call.received', 'tool.call.permission_decided', 'tool.call.started', 'tool.call.completed', 'tool.batch.completed'
    ]))
    expect(events.find((event) => event.event === 'tool.call.completed')).toMatchObject({
      sessionId: 's1', turnId: 't1', callId: 'c1', toolName: 'JournalExample', source: 'builtin'
    })
  })

  it('records persistence bytes, permission metadata, and hook duration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-tool-journal-persist-'))
    roots.push(root)
    const journalPath = path.join(root, 'journal.jsonl')
    const handler = {
      descriptor: {
        name: 'LargeJournalResult', aliases: [], version: 'v1', source: 'mcp', sourceId: 'mcp:test',
        summary: 'journal', description: 'journal', inputSchema: { type: 'object', additionalProperties: false },
        availability: { enabled: () => true, roles: '*', exposure: 'core' },
        behavior: { readOnly: () => true, destructive: () => false, concurrency: 'safe', interrupt: 'cancel', maxResultChars: 10 },
        planEffects: async () => ({ effects: [{ kind: 'external-effect', target: 'mcp:test' }], analysisStatus: 'parsed' }),
        resourceKeys: async () => []
      },
      execute: async () => ({ status: 'success' as const, modelContent: 'x'.repeat(100) })
    } as ToolHandler<Record<string, unknown>>
    const registry = new ToolRegistry(); registry.register(handler)
    const catalog = registry.createSnapshot({ platform: process.platform, agentRole: 'main' })
    const processor = new ToolResultProcessor(
      new LargeToolResultStore(path.join(root, 'results')),
      { softChars: 10, hardBytes: 1000, batchChars: 1000, previewChars: 5, errorChars: 10 }
    )
    const pipeline = new ToolExecutionPipeline({
      journal: new ToolExecutionJournal(journalPath),
      resultProcessor: processor,
      hooks: [{ name: 'timed', beforeExecute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { action: 'continue' }
      } }]
    })
    await pipeline.executeBatch([
      { callId: 'large-1', position: 0, name: 'LargeJournalResult', rawArguments: '{}' }
    ], {
      catalog, workspaceRoot: root, sessionId: 's1', agentRole: 'main', journalIdentity: { sessionId: 's1' },
      authorize: async () => ({ allowed: true, requestId: 'permission', permissionRuleId: 'effect.external', permissionMode: 'auto' }),
      createToolContext: () => ({ workspaceRoot: root, sessionId: 's1' })
    })
    const events = (await readFile(journalPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(events.find((event) => event.event === 'tool.call.permission_decided')).toMatchObject({
      permissionRuleId: 'effect.external', permissionMode: 'auto'
    })
    expect(events.find((event) => event.event === 'tool.call.completed').hookDurationMs).toBeGreaterThanOrEqual(1)
    expect(events.find((event) => event.event === 'tool.result.persisted')).toMatchObject({ persistedBytes: 100 })
  })

  it('honors a tool-specific 100k inline result budget', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-tool-result-limit-'))
    roots.push(root)
    const content = 'x'.repeat(60_000)
    const processor = new ToolResultProcessor(new LargeToolResultStore(path.join(root, 'results')))
    const [processed] = await processor.processBatch([{
      call: { callId: 'mcp-large', position: 0, name: 'mcp__test__large', rawArguments: '{}' },
      canonicalName: 'mcp__test__large',
      maxResultChars: 100_000,
      result: { status: 'success', modelContent: content }
    } satisfies ToolPipelineResult], { workspaceRoot: root, sessionId: 's1' })
    expect(processed.result.status).toBe('success')
    expect(processed.result.modelContent).toBe(content)
    expect(processed.result.modelContent).not.toContain('<persisted-tool-result ')
  })

  it('rotates journal files at the configured size limit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-tool-journal-rotate-'))
    roots.push(root)
    const journalPath = path.join(root, 'journal.jsonl')
    const journal = new ToolExecutionJournal(journalPath, { maxBytes: 180, maxFiles: 3, maxAgeMs: 60_000 })
    for (let index = 0; index < 8; index++) {
      await journal.append({ event: 'tool.call.received', callId: `call-${index}`, toolName: 'Rotate' })
    }
    await expect(access(`${journalPath}.1`)).resolves.toBeUndefined()
    await expect(access(`${journalPath}.3`)).rejects.toThrow()
  })
})
