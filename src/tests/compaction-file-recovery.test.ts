import { createHash } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { CompactionService } from '../main/services/context/CompactionService'
import { ModelLedgerStore } from '../main/services/context/ModelLedgerStore'
import { SessionRuntimeCoordinator } from '../main/services/context/SessionRuntimeCoordinator'
import { ModelContextBuilder } from '../main/services/context/ModelContextBuilder'
import { EditTool } from '../main/tools/builtin/EditTool'
import { getReadFingerprintStore } from '../main/tools/ReadFingerprintStore'
import type { CompactionSummaryV1 } from '../shared/types/context'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function summary(sequence: number): CompactionSummaryV1 {
  return {
    version: 1,
    goal: { currentObjective: 'continue editing', requirements: [], successCriteria: [] },
    status: { phase: 'implementation', completed: [], inProgress: [], nextActions: [] },
    decisions: [], facts: [], files: [], validation: [], errors: [],
    openQuestions: [], userInstructions: [], coveredThroughSequence: sequence
  }
}

describe('compaction file working-set recovery', () => {
  it('restores the latest disk version and rebuilds Edit authorization', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-compact-files-'))
    dirs.push(root)
    const workspace = path.join(root, 'workspace')
    await mkdir(workspace)
    const filePath = path.join(workspace, 'active.ts')
    await writeFile(filePath, 'export const value = 1\n')
    const original = await readFile(filePath)
    const originalSha = createHash('sha256').update(original).digest('hex')
    const ledger = new ModelLedgerStore(path.join(root, 'runtime'))
    const runtime = new SessionRuntimeCoordinator(ledger)

    const readTurn = await runtime.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: 'inspect active file'
    })
    await runtime.recordAssistant(readTurn, {
      content: '',
      toolCalls: [{ id: 'read-1', name: 'Read', arguments: '{}' }]
    })
    await runtime.recordToolResult(readTurn, {
      callId: 'read-1',
      name: 'Read',
      content: JSON.stringify({ ok: true, data: '1\texport const value = 1' }),
      status: 'success',
      fileReferences: [{
        path: filePath,
        sha256: originalSha,
        operation: 'read',
        contentIncluded: true,
        contentSha256: 'range-v1',
        offset: 1,
        limit: 1
      }]
    })
    await runtime.completeTurn(readTurn, { stopReason: 'tool_calls' })

    for (let index = 0; index < 7; index++) {
      const turn = await runtime.beginTurn({
        sessionId: 's1', contextScopeId: 'main', text: `question ${index} ${'Q'.repeat(3_000)}`
      })
      await runtime.recordAssistant(turn, { content: `answer ${index} ${'A'.repeat(3_000)}` })
      await runtime.completeTurn(turn, { stopReason: 'stop' })
    }
    await writeFile(filePath, 'export const value = 2\n')

    const service = new CompactionService(ledger, {
      generate: async (input) => JSON.stringify(summary(input.coveredThroughSequence))
    })
    const result = await service.compact({
      sessionId: 's1',
      contextScopeId: 'main',
      trigger: 'manual',
      capabilities: { contextWindowTokens: 12_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system',
      workspaceRoot: workspace
    })

    expect(result.status).toBe('completed')
    const scope = (await ledger.load('s1')).scopes.main
    const restored = scope.postCompactionFileContext
    expect(restored?.content).toContain('export const value = 2')
    expect(restored?.fileReferences?.[0]).toMatchObject({
      path: filePath,
      operation: 'read',
      contentIncluded: true
    })
    expect(scope.activeMessages.some((message) => message.turnId.startsWith('compact-files:'))).toBe(false)

    const store = getReadFingerprintStore()
    store.clear('s1')
    const nextTurn = await runtime.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: 'continue editing'
    })
    const built = await new ModelContextBuilder(ledger).build({
      sessionId: 's1', contextScopeId: 'main',
      currentInputMessageId: nextTurn.userMessageId,
      currentInput: nextTurn.inputText,
      capabilities: { contextWindowTokens: 12_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system', toolSchemas: []
    })
    const fileContextIndex = built.items.findIndex((item) => item.kind === 'file_context')
    const currentInputIndex = built.items.findIndex((item) =>
      item.message.role === 'user' && item.message.content === 'continue editing'
    )
    expect(fileContextIndex).toBeGreaterThanOrEqual(0)
    expect(fileContextIndex).toBe(currentInputIndex - 1)
    expect(built.items[fileContextIndex].message.role).toBe('assistant')
    expect(built.messages[fileContextIndex]).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('export const value = 2')
    })
    expect(built.messages[fileContextIndex + 1]).toMatchObject({
      role: 'user',
      content: 'continue editing'
    })
    expect(built.messages.filter((message) => message.role === 'system')
      .map((message) => message.content).join('\n')).not.toContain('export const value = 2')
    expect(built.messages.at(-1)).toMatchObject({ role: 'user', content: 'continue editing' })
    expect((await ledger.load('s1')).scopes.main.activeMessages
      .some((message) => message.id.startsWith('file-context:'))).toBe(false)
    store.replaceScopeDeliveries('s1', 'main', built.items.map((item) => item.message))
    const editArguments = JSON.stringify({
      file_path: filePath,
      old_string: 'value = 2',
      new_string: 'value = 3'
    })
    await runtime.recordAssistant(nextTurn, {
      content: '',
      toolCalls: [{ id: 'edit-1', name: 'Edit', arguments: editArguments }],
      usage: { inputTokens: 50_000, outputTokens: 100, totalTokens: 50_100 }
    })
    const editResult = await new EditTool().executeWithMetadata(
      editArguments,
      { workspaceRoot: workspace, sessionId: 's1', contextScopeId: 'main' }
    )
    expect(editResult.content).not.toContain('must Read')
    await runtime.recordToolResult(nextTurn, {
      callId: 'edit-1', name: 'Edit', content: editResult.content, status: 'success',
      fileReferences: editResult.fileReferences
    })
    expect(await readFile(filePath, 'utf8')).toContain('value = 3')

    const afterEdit = await new ModelContextBuilder(ledger).build({
      sessionId: 's1', contextScopeId: 'main',
      currentInputMessageId: nextTurn.userMessageId,
      currentInput: nextTurn.inputText,
      capabilities: { contextWindowTokens: 12_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system', toolSchemas: [], workspaceRoot: workspace
    })
    expect(afterEdit.items.some((item) => item.kind === 'file_context')).toBe(false)
    expect(afterEdit.budget.estimateSource).toBe('heuristic')
    expect(afterEdit.messages.some((message) =>
      typeof message.content === 'string' && message.content.includes('value = 2')
    )).toBe(false)
    expect((await ledger.load('s1')).scopes.main.activeMessages
      .some((message) => message.turnId.startsWith('compact-files:'))).toBe(false)
  })
})
