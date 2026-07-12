import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { LargeToolResultStore } from '../main/tools/runtime/LargeToolResultStore'
import { ToolResultProcessor } from '../main/tools/runtime/ToolResultProcessor'
import type { ToolPipelineResult } from '../main/tools/runtime/types'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function result(content: string): ToolPipelineResult {
  return {
    call: { callId: 'call-1', position: 0, name: 'Example', rawArguments: '{}' },
    canonicalName: 'Example',
    result: { status: 'success', modelContent: content }
  }
}

describe('LargeToolResultStore', () => {
  it('persists large output outside the workspace and reads it only by opaque handle', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-large-result-'))
    roots.push(root)
    const store = new LargeToolResultStore(root)
    const full = '0123456789'.repeat(100)
    const persisted = await store.persist({
      workspaceRoot: 'C:\\workspace', sessionId: 'session-1', callId: 'call-1', toolName: 'Example', content: full
    })
    expect(persisted.handle).toMatch(/^tool-result:\/\//)
    const chunk = await store.read({
      workspaceRoot: 'C:\\workspace', sessionId: 'session-1', handle: persisted.handle, offset: 10, limit: 20
    })
    expect(chunk.content).toBe(full.slice(10, 30))
    await expect(store.read({
      workspaceRoot: 'C:\\workspace', sessionId: 'other-session', handle: persisted.handle
    })).rejects.toThrow()
  })

  it('replaces oversized model content with a bounded persisted preview', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-result-processor-'))
    roots.push(root)
    const processor = new ToolResultProcessor(new LargeToolResultStore(root), {
      softChars: 100,
      hardBytes: 200,
      batchChars: 150,
      previewChars: 40,
      errorChars: 20
    })
    const [processed] = await processor.processBatch([result('x'.repeat(500))], {
      workspaceRoot: 'C:\\workspace', sessionId: 'session-1'
    })
    expect(processed.result.status).toBe('success')
    expect(processed.result.status === 'success' && processed.result.modelContent).toContain('tool-result://')
    expect(processed.result.status === 'success' && processed.result.modelContent.length).toBeLessThan(500)
  })
})
