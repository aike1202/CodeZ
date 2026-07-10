import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { ModelLedgerStore } from '../main/services/context/ModelLedgerStore'
import { SessionRuntimeCoordinator } from '../main/services/context/SessionRuntimeCoordinator'
import { ModelContextBuilder } from '../main/services/context/ModelContextBuilder'
import { ResumeStateManager } from '../main/services/context/ResumeStateManager'
import type { ResumeState } from '../shared/types/context'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

function resumeState(): ResumeState {
  return {
    currentGoalId: 'goal', currentPhase: 'implementation', currentStep: 'builder', nextAction: 'test',
    openQuestions: [], blockedBy: [], filesTouched: ['src/a.ts'], filesToInspectNext: [], validationPending: []
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codez-builder-'))
  dirs.push(root)
  const ledger = new ModelLedgerStore(root)
  const runtime = new SessionRuntimeCoordinator(ledger)
  const first = await runtime.beginTurn({ sessionId: 's1', contextScopeId: 'main', text: 'old question' })
  await runtime.recordAssistant(first, { content: 'old answer' })
  await runtime.completeTurn(first, { stopReason: 'stop' })
  const current = await runtime.beginTurn({ sessionId: 's1', contextScopeId: 'main', text: 'current input' })
  const state = await ledger.load('s1')
  const manager = new ResumeStateManager()
  await ledger.append('s1', 'main', 'resume_state_updated', {
    resumeState: manager.create(resumeState(), 'explicit_tool', state.throughSequence)
  }, current.turnId)
  return { ledger, runtime, current, builder: new ModelContextBuilder(ledger) }
}

describe('ModelContextBuilder', () => {
  it('builds system, resume, recent history, and current input in order', async () => {
    const f = await fixture()
    const built = await f.builder.build({
      sessionId: 's1', contextScopeId: 'main', currentInputMessageId: f.current.userMessageId,
      currentInput: 'current input', capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system', toolSchemas: []
    })
    expect(built.items.map((item) => item.kind)).toEqual(['system', 'resume_state', 'user', 'assistant', 'user'])
    expect(built.messages.at(-1)).toEqual(expect.objectContaining({ role: 'user', content: 'current input' }))
    expect(built.budget.totalInputTokens).toBeLessThan(built.budget.hardInputLimit)
  })

  it('rejects a current input that alone exceeds the hard input limit', async () => {
    const f = await fixture()
    await expect(f.builder.build({
      sessionId: 's1', contextScopeId: 'main', currentInputMessageId: f.current.userMessageId,
      currentInput: 'X'.repeat(20_000), capabilities: { contextWindowTokens: 1_000, maxOutputTokens: 200 },
      systemPrompt: 'system', toolSchemas: []
    })).rejects.toMatchObject({ code: 'CURRENT_INPUT_TOO_LARGE' })
  })

  it('includes dynamic instructions in both the request and its budget', async () => {
    const f = await fixture()
    const built = await f.builder.build({
      sessionId: 's1', contextScopeId: 'main', currentInputMessageId: f.current.userMessageId,
      currentInput: 'current input', capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system', toolSchemas: [], instructions: ['dynamic reminder']
    })
    expect(built.messages).toContainEqual({ role: 'system', content: 'dynamic reminder' })
    expect(built.budget.instructionTokens).toBeGreaterThan(0)
  })
})
