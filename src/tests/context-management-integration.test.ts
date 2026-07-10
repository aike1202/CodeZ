import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { SessionStore } from '../main/services/SessionStore'
import { CompactionService } from '../main/services/context/CompactionService'
import { LegacySessionMigrationService } from '../main/services/context/LegacySessionMigrationService'
import { ModelContextBuilder } from '../main/services/context/ModelContextBuilder'
import { ModelHistoryNormalizer } from '../main/services/context/ModelHistoryNormalizer'
import { ModelLedgerStore } from '../main/services/context/ModelLedgerStore'
import { SessionRuntimeCoordinator } from '../main/services/context/SessionRuntimeCoordinator'
import type { CompactionSummaryV1 } from '../shared/types/context'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function summary(sequence: number, phase = 'work'): CompactionSummaryV1 {
  return {
    version: 1,
    goal: { currentObjective: 'finish migration safely', requirements: [], successCriteria: [] },
    status: { phase, completed: [], inProgress: [], nextActions: ['continue'] },
    decisions: [], facts: [], files: [], validation: [], errors: [],
    openQuestions: [], userInstructions: [], coveredThroughSequence: sequence
  }
}

describe('durable context management integration', () => {
  it('migrates, compacts, and continues without changing the UI transcript', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-context-integration-'))
    dirs.push(root)
    const sessions = new SessionStore(path.join(root, 'sessions.json'))
    const uiMessages = [
      { id: 'u1', role: 'user', content: 'legacy request' },
      { id: 'a1', role: 'agent', content: 'legacy answer with full UI formatting' }
    ]
    await sessions.save({
      id: 's1', projectId: 'p1', summary: 'legacy', relativeTime: 'now', messages: uiMessages
    })
    const originalUiBytes = JSON.stringify(sessions.get('s1')?.messages)
    const ledger = new ModelLedgerStore(path.join(root, 'runtime'))
    const migrationSummary = vi.fn().mockResolvedValue(summary(0, 'migration'))
    await new LegacySessionMigrationService(sessions, ledger, {
      summarize: migrationSummary
    }).ensureMigrated('s1')

    const coordinator = new SessionRuntimeCoordinator(ledger)
    for (let index = 0; index < 5; index++) {
      const turn = await coordinator.beginTurn({
        sessionId: 's1', contextScopeId: 'main',
        text: `question ${index} ${'Q'.repeat(2_000)}`
      })
      await coordinator.recordAssistant(turn, {
        content: `answer ${index} ${'A'.repeat(2_000)}`
      })
      await coordinator.completeTurn(turn, { stopReason: 'stop' })
    }

    const generate = vi.fn(async (input: { coveredThroughSequence: number }) =>
      JSON.stringify(summary(input.coveredThroughSequence, 'compacted'))
    )
    const compaction = new CompactionService(ledger, { generate })
    const compacted = await compaction.compact({
      sessionId: 's1', contextScopeId: 'main', trigger: 'manual',
      capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system', manualInstructions: '保留数据库选择依据'
    })
    expect(compacted.status).toBe('completed')
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      instructions: '保留数据库选择依据'
    }))

    const current = await coordinator.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: 'continue after compaction'
    })
    const built = await new ModelContextBuilder(ledger).build({
      sessionId: 's1', contextScopeId: 'main',
      currentInputMessageId: current.userMessageId,
      currentInput: current.inputText,
      capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system', toolSchemas: []
    })
    expect(built.items.some((item) => item.kind === 'compaction_summary')).toBe(true)
    expect(built.messages.at(-1)).toMatchObject({ role: 'user', content: 'continue after compaction' })
    const scope = (await ledger.load('s1')).scopes.main
    expect(() => ModelHistoryNormalizer.assertProtocolInvariant(scope.activeMessages)).not.toThrow()
    expect(JSON.stringify(sessions.get('s1')?.messages)).toBe(originalUiBytes)
    expect(sessions.get('s1')?.runtime?.schemaVersion).toBe(2)
  })
})
