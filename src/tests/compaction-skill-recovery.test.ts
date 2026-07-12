import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { CompactionService } from '../main/services/context/CompactionService'
import { ModelLedgerStore } from '../main/services/context/ModelLedgerStore'
import { SessionRuntimeCoordinator } from '../main/services/context/SessionRuntimeCoordinator'
import { ModelContextBuilder } from '../main/services/context/ModelContextBuilder'
import type { CompactionSummaryV1 } from '../shared/types/context'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function summary(sequence: number): CompactionSummaryV1 {
  return {
    version: 1,
    goal: { currentObjective: 'continue', requirements: [], successCriteria: [] },
    status: { phase: 'work', completed: [], inProgress: [], nextActions: [] },
    decisions: [], facts: [], files: [], validation: [], errors: [],
    openQuestions: [], userInstructions: [], coveredThroughSequence: sequence
  }
}

describe('compaction invoked-skill recovery', () => {
  it('reinjects a covered Skill result before the next user input', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-compact-skill-'))
    roots.push(root)
    const ledger = new ModelLedgerStore(path.join(root, 'runtime'))
    const runtime = new SessionRuntimeCoordinator(ledger)
    const skillTurn = await runtime.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: 'load the review skill'
    })
    await runtime.recordAssistant(skillTurn, {
      content: '',
      toolCalls: [{
        id: 'skill-1', name: 'Skill', arguments: JSON.stringify({ skill: 'Review' })
      }]
    })
    await runtime.recordToolResult(skillTurn, {
      callId: 'skill-1', name: 'Skill', status: 'success',
      content: JSON.stringify({
        ok: true,
        data: '<command-name>Review</command-name>\nFollow the review checklist.'
      })
    })
    await runtime.completeTurn(skillTurn, { stopReason: 'tool_calls' })

    for (let index = 0; index < 7; index++) {
      const turn = await runtime.beginTurn({
        sessionId: 's1', contextScopeId: 'main', text: `question ${index} ${'Q'.repeat(3_000)}`
      })
      await runtime.recordAssistant(turn, { content: `answer ${index} ${'A'.repeat(3_000)}` })
      await runtime.completeTurn(turn, { stopReason: 'stop' })
    }

    const compact = new CompactionService(ledger, {
      generate: async (input) => JSON.stringify(summary(input.coveredThroughSequence))
    })
    const result = await compact.compact({
      sessionId: 's1', contextScopeId: 'main', trigger: 'manual',
      capabilities: { contextWindowTokens: 12_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system'
    })

    expect(result.status).toBe('completed')
    const scope = (await ledger.load('s1')).scopes.main
    expect(scope.postCompactionSkillContext?.skills).toEqual([
      expect.objectContaining({ name: 'Review' })
    ])
    expect(scope.activeMessages.some((message) => message.name === 'Skill')).toBe(false)

    const next = await runtime.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: 'continue the review'
    })
    const built = await new ModelContextBuilder(ledger).build({
      sessionId: 's1', contextScopeId: 'main',
      currentInputMessageId: next.userMessageId, currentInput: next.inputText,
      capabilities: { contextWindowTokens: 12_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system', toolSchemas: [], allowCompaction: false
    })
    const skillIndex = built.items.findIndex((item) => item.kind === 'skill_context')
    const inputIndex = built.items.findIndex((item) =>
      'id' in item.message && item.message.id === next.userMessageId
    )
    expect(skillIndex).toBeGreaterThan(-1)
    expect(skillIndex).toBeLessThan(inputIndex)
    expect(built.items[skillIndex].message.content).toContain('Follow the review checklist')
  })
})
