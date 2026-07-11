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

  it('bounds an oversized recent tool result without changing the ledger', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-builder-huge-tool-'))
    dirs.push(root)
    const ledger = new ModelLedgerStore(root)
    const runtime = new SessionRuntimeCoordinator(ledger)
    const first = await runtime.beginTurn({ sessionId: 'huge', contextScopeId: 'main', text: 'list files' })
    await runtime.recordAssistant(first, {
      content: '',
      toolCalls: [{ id: 'glob-1', name: 'Glob', arguments: '{"pattern":"**/*"}' }]
    })
    const huge = JSON.stringify({ ok: true, data: 'G'.repeat(621_396) })
    await runtime.recordToolResult(first, {
      callId: 'glob-1', name: 'Glob', content: huge, status: 'success'
    })
    await runtime.completeTurn(first, { stopReason: 'tool_calls' })
    const current = await runtime.beginTurn({
      sessionId: 'huge', contextScopeId: 'main', text: 'continue'
    })

    const built = await new ModelContextBuilder(ledger).build({
      sessionId: 'huge', contextScopeId: 'main',
      currentInputMessageId: current.userMessageId,
      currentInput: current.inputText,
      capabilities: { contextWindowTokens: 200_000, maxOutputTokens: 8_192 },
      systemPrompt: 'system', toolSchemas: []
    })

    expect(built.budget.rawHistoryTokens).toBeGreaterThan(150_000)
    expect(built.budget.recentHistoryTokens).toBeLessThan(10_000)
    expect(built.messages.find((message) => message.role === 'tool')?.content).toContain('TOOL_OUTPUT_PRUNED')
    expect((await ledger.load('huge')).scopes.main.activeMessages.find((message) => message.name === 'Glob')?.content).toBe(huge)
  })

  it('applies the single-tool cap before overall pressure reaches the prune threshold', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-builder-tool-cap-'))
    dirs.push(root)
    const ledger = new ModelLedgerStore(root)
    const runtime = new SessionRuntimeCoordinator(ledger)
    const first = await runtime.beginTurn({
      sessionId: 'tool-cap', contextScopeId: 'main', text: 'generate a medium report'
    })
    await runtime.recordAssistant(first, {
      content: '',
      toolCalls: [{ id: 'report-1', name: 'Report', arguments: '{}' }]
    })
    await runtime.recordToolResult(first, {
      callId: 'report-1', name: 'Report', content: 'R'.repeat(40_000), status: 'success'
    })
    await runtime.completeTurn(first, { stopReason: 'tool_calls' })
    const current = await runtime.beginTurn({
      sessionId: 'tool-cap', contextScopeId: 'main', text: 'continue'
    })

    const built = await new ModelContextBuilder(ledger).build({
      sessionId: 'tool-cap', contextScopeId: 'main',
      currentInputMessageId: current.userMessageId,
      currentInput: current.inputText,
      capabilities: { contextWindowTokens: 200_000, maxOutputTokens: 8_192 },
      systemPrompt: 'system', toolSchemas: []
    })

    expect(built.budget.rawHistoryTokens / built.budget.usableInputBudget).toBeLessThan(0.8)
    expect(built.messages.find((message) => message.role === 'tool')?.content)
      .toContain('TOOL_OUTPUT_PRUNED')
  })

  it('keeps a current-turn tool result intact for its first model delivery', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-builder-fresh-tool-'))
    dirs.push(root)
    const ledger = new ModelLedgerStore(root)
    const runtime = new SessionRuntimeCoordinator(ledger)
    const turn = await runtime.beginTurn({
      sessionId: 'fresh-tool', contextScopeId: 'main', text: 'inspect files'
    })
    await runtime.recordAssistant(turn, {
      content: '',
      toolCalls: [{ id: 'read-1', name: 'Read', arguments: '{}' }]
    })
    const fresh = 'F'.repeat(40_000)
    await runtime.recordToolResult(turn, {
      callId: 'read-1', name: 'Read', content: fresh, status: 'success'
    })

    const built = await new ModelContextBuilder(ledger).build({
      sessionId: 'fresh-tool', contextScopeId: 'main',
      currentInputMessageId: turn.userMessageId,
      currentInput: turn.inputText,
      capabilities: { contextWindowTokens: 200_000, maxOutputTokens: 8_192 },
      systemPrompt: 'system', toolSchemas: []
    })

    expect(built.messages.find((message) => message.role === 'tool')?.content).toBe(fresh)
  })
})
