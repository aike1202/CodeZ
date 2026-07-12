import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { FileContextProjector } from '../main/services/context/FileContextProjector'
import { ReadTool } from '../main/tools/builtin/ReadTool'
import type { NormalizedModelMessage } from '../shared/types/context'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function readResult(id: string, content: string): NormalizedModelMessage {
  return {
    id,
    turnId: id,
    role: 'tool',
    name: 'Read',
    toolCallId: `call-${id}`,
    content: JSON.stringify({ ok: true, data: `<file path="a.ts">\n${content}\n</file>` }),
    status: 'complete',
    createdAt: '2026-07-12T00:00:00.000Z',
    fileReferences: [{
      path: 'C:\\repo\\a.ts',
      sha256: 'file-sha',
      operation: 'read',
      contentIncluded: true,
      contentSha256: 'range-sha',
      offset: 1,
      limit: 100
    }]
  }
}

function rangedRead(
  id: string,
  files: Array<{ name: string; body: string; sha?: string }>
): NormalizedModelMessage {
  const blocks = files.map((file) => `<file path="${file.name}">\n${file.body}\n</file>`)
  let cursor = 0
  const fileReferences = files.map((file, index) => {
    const start = cursor
    const end = start + blocks[index].length
    cursor = end + (index < blocks.length - 1 ? 2 : 0)
    return {
      path: `C:\\repo\\${file.name}`,
      sha256: file.sha || `${file.name}-sha`,
      operation: 'read' as const,
      contentIncluded: true,
      contentSha256: `${file.name}:${file.sha || 'same-range'}`,
      offset: 1,
      limit: 100,
      resultBlockStart: start,
      resultBlockEnd: end
    }
  })
  return {
    id,
    turnId: id,
    role: 'tool',
    name: 'Read',
    toolCallId: `call-${id}`,
    content: JSON.stringify({ ok: true, data: blocks.join('\n\n') }),
    status: 'complete',
    createdAt: '2026-07-12T00:00:00.000Z',
    fileReferences
  }
}

describe('FileContextProjector', () => {
  it('keeps one canonical Read body and replaces later identical deliveries', () => {
    const original = [readResult('first', 'full body'), readResult('second', 'full body')]
    const projected = new FileContextProjector().project(original)

    expect(projected.messages[0].content).toContain('full body')
    expect(projected.messages[1].content).toContain('earlier Read tool result')
    expect(projected.messages[1].fileReferences?.[0].contentIncluded).toBe(false)
    expect(projected.protectedMessageIds).toEqual(new Set(['first']))
    expect(projected.duplicateReadResults).toBe(1)
    expect(original[1].content).toContain('full body')
  })

  it('does not deduplicate a new file version or a different rendered range', () => {
    const changed = readResult('changed', 'changed body')
    changed.fileReferences![0].sha256 = 'new-file-sha'
    const otherRange = readResult('range', 'other range')
    otherRange.fileReferences![0].contentSha256 = 'other-range-sha'

    const projected = new FileContextProjector().project([
      readResult('first', 'full body'), changed, otherRange
    ])
    expect(projected.duplicateReadResults).toBe(0)
  })

  it('deduplicates identical rendered content despite a different requested limit', () => {
    const first = readResult('first-limit', 'short file')
    const second = readResult('second-limit', 'short file')
    second.fileReferences![0].limit = 1_200

    expect(new FileContextProjector().project([first, second]).duplicateReadResults).toBe(1)
  })

  it('does not protect a unique Read or swallow errors from a partial batch', () => {
    const unique = readResult('unique', 'full body')
    const partial = readResult('partial', 'full body')
    partial.content = JSON.stringify({
      ok: true,
      data: '<file path="a.ts">\nfull body\n</file>\n<file path="missing.ts">\nError: missing\n</file>'
    })

    expect(new FileContextProjector().project([unique]).protectedMessageIds.size).toBe(0)
    expect(new FileContextProjector().project([unique, partial]).duplicateReadResults).toBe(0)
  })

  it('deduplicates unchanged files inside overlapping Read batches', () => {
    const first = rangedRead('first-batch', [
      { name: 'a.ts', body: 'A_BODY' },
      { name: 'b.ts', body: 'B_OLD', sha: 'b-old' }
    ])
    const second = rangedRead('second-batch', [
      { name: 'a.ts', body: 'A_BODY' },
      { name: 'b.ts', body: 'B_NEW', sha: 'b-new' }
    ])

    const projected = new FileContextProjector().project([first, second])
    const serialized = projected.messages.map((message) => message.content).join('\n')

    expect(serialized.match(/A_BODY/g)).toHaveLength(1)
    expect(serialized).toContain('B_OLD')
    expect(serialized).toContain('B_NEW')
    expect(projected.messages[1].content).toContain('read_reference')
    expect(projected.messages[1].fileReferences?.[0].contentIncluded).toBe(false)
    expect(projected.messages[1].fileReferences?.[1].contentIncluded).toBe(true)
    expect(projected.protectedMessageIds).toEqual(new Set(['first-batch']))
    expect(projected.duplicateReadResults).toBe(1)
  })

  it('preserves an error block while deduplicating a successful block in a partial batch', () => {
    const first = rangedRead('partial-first', [{ name: 'a.ts', body: 'A_BODY' }])
    const second = rangedRead('partial-second', [{ name: 'a.ts', body: 'A_BODY' }])
    const wrapper = JSON.parse(second.content)
    wrapper.data += '\n\n<file path="missing.ts">\nError: File not found.\n</file>'
    second.content = JSON.stringify(wrapper)

    const projected = new FileContextProjector().project([first, second])
    const projectedData = JSON.parse(projected.messages[1].content).data

    expect(projectedData).toContain('read_reference')
    expect(projectedData).toContain('Error: File not found.')
    expect(projected.duplicateReadResults).toBe(1)
  })

  it('applies ReadTool offsets inside the durable JSON result wrapper', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-projector-wrapper-'))
    roots.push(root)
    const filePath = path.join(root, 'quoted.ts')
    await writeFile(filePath, 'export const quoted = "\\n"\nexport const slash = "\\\\"\n')
    const tool = new ReadTool()
    const args = JSON.stringify({ files: [{ file_path: filePath }] })
    const first = await tool.executeWithMetadata(args, { workspaceRoot: root, sessionId: 's1' })
    const second = await tool.executeWithMetadata(args, { workspaceRoot: root, sessionId: 's1' })
    const message = (
      id: string,
      output: typeof first
    ): NormalizedModelMessage => ({
      id,
      turnId: id,
      role: 'tool',
      name: 'Read',
      toolCallId: `call-${id}`,
      content: JSON.stringify({ ok: true, data: output.content }),
      status: 'complete',
      createdAt: '2026-07-12T00:00:00.000Z',
      fileReferences: output.fileReferences
    })

    const projected = new FileContextProjector().project([
      message('first-real', first),
      message('second-real', second)
    ])
    const firstWrapper = JSON.parse(projected.messages[0].content)
    const secondWrapper = JSON.parse(projected.messages[1].content)

    expect(firstWrapper.data).toContain('export const quoted')
    expect(secondWrapper).toMatchObject({ ok: true })
    expect(secondWrapper.data).toContain('read_reference')
    expect(secondWrapper.data).not.toContain('export const quoted')
  })
})
