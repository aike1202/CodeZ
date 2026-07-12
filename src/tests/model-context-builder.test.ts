import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('allows an old unique Read body to be pruned by the single-tool cap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-builder-read-cap-'))
    dirs.push(root)
    const ledger = new ModelLedgerStore(root)
    const runtime = new SessionRuntimeCoordinator(ledger)
    const first = await runtime.beginTurn({
      sessionId: 'read-cap', contextScopeId: 'main', text: 'read file'
    })
    await runtime.recordAssistant(first, {
      content: '', toolCalls: [{ id: 'read-1', name: 'Read', arguments: '{}' }]
    })
    await runtime.recordToolResult(first, {
      callId: 'read-1',
      name: 'Read',
      content: JSON.stringify({ ok: true, data: `<file path="a.ts">\n${'R'.repeat(40_000)}\n</file>` }),
      status: 'success',
      fileReferences: [{
        path: path.join(root, 'a.ts'), sha256: 'file-sha', operation: 'read',
        contentIncluded: true, contentSha256: 'range-sha', offset: 1, limit: 1
      }]
    })
    await runtime.completeTurn(first, { stopReason: 'tool_calls' })
    const current = await runtime.beginTurn({
      sessionId: 'read-cap', contextScopeId: 'main', text: 'continue'
    })

    const built = await new ModelContextBuilder(ledger).build({
      sessionId: 'read-cap', contextScopeId: 'main',
      currentInputMessageId: current.userMessageId,
      currentInput: current.inputText,
      capabilities: { contextWindowTokens: 200_000, maxOutputTokens: 8_192 },
      systemPrompt: 'system', toolSchemas: []
    })

    expect(built.messages.find((message) => message.name === 'Read')?.content)
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

  it('uses the durable provider response as a baseline plus messages added after it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-builder-provider-baseline-'))
    dirs.push(root)
    const ledger = new ModelLedgerStore(root)
    const runtime = new SessionRuntimeCoordinator(ledger)
    const first = await runtime.beginTurn({
      sessionId: 'usage', contextScopeId: 'main', text: 'first request'
    })
    const firstBuilt = await new ModelContextBuilder(ledger).build({
      sessionId: 'usage', contextScopeId: 'main',
      currentInputMessageId: first.userMessageId,
      currentInput: first.inputText,
      capabilities: { contextWindowTokens: 200_000, maxOutputTokens: 8_192 },
      systemPrompt: 'system', toolSchemas: []
    })
    await runtime.recordAssistant(first, {
      content: 'first response',
      usage: { inputTokens: 49_000, outputTokens: 1_000, totalTokens: 50_000 },
      requestFingerprint: firstBuilt.providerUsageRequestFingerprint
    })
    await runtime.completeTurn(first, { stopReason: 'stop' })
    const current = await runtime.beginTurn({
      sessionId: 'usage', contextScopeId: 'main', text: 'new input after measured response'
    })

    const built = await new ModelContextBuilder(ledger).build({
      sessionId: 'usage', contextScopeId: 'main',
      currentInputMessageId: current.userMessageId,
      currentInput: current.inputText,
      capabilities: { contextWindowTokens: 200_000, maxOutputTokens: 8_192 },
      systemPrompt: 'system', toolSchemas: []
    })

    expect(built.budget.estimateSource).toBe('provider')
    expect(built.budget.totalInputTokens).toBeGreaterThan(50_000)
    const scope = (await ledger.load('usage')).scopes.main
    expect(scope.lastProviderUsageMessageId).toBeTruthy()
    expect(scope.lastProviderUsage?.totalTokens).toBe(50_000)
    expect(scope.lastProviderUsageRequestFingerprint)
      .toBe(firstBuilt.providerUsageRequestFingerprint)
  })

  it('ignores a provider baseline when the reconstructed request prefix changed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-builder-provider-prefix-'))
    dirs.push(root)
    const ledger = new ModelLedgerStore(root)
    const runtime = new SessionRuntimeCoordinator(ledger)
    const first = await runtime.beginTurn({
      sessionId: 'prefix', contextScopeId: 'main', text: 'first request',
      providerId: 'p1', model: 'm1'
    })
    const builder = new ModelContextBuilder(ledger)
    const measured = await builder.build({
      sessionId: 'prefix', contextScopeId: 'main',
      currentInputMessageId: first.userMessageId, currentInput: first.inputText,
      capabilities: { contextWindowTokens: 200_000, maxOutputTokens: 8_192 },
      systemPrompt: 'old system', toolSchemas: [{ name: 'old tool' }]
    })
    await runtime.recordAssistant(first, {
      content: 'answer',
      usage: { inputTokens: 80_000, outputTokens: 100, totalTokens: 80_100 },
      requestFingerprint: measured.providerUsageRequestFingerprint
    })
    await runtime.completeTurn(first, { stopReason: 'stop' })
    const current = await runtime.beginTurn({
      sessionId: 'prefix', contextScopeId: 'main', text: 'second request',
      providerId: 'p1', model: 'm1'
    })

    const changed = await builder.build({
      sessionId: 'prefix', contextScopeId: 'main',
      currentInputMessageId: current.userMessageId, currentInput: current.inputText,
      capabilities: { contextWindowTokens: 200_000, maxOutputTokens: 8_192 },
      systemPrompt: 'new system', toolSchemas: [{ name: 'new tool' }]
    })

    expect(changed.budget.estimateSource).not.toBe('provider')
    expect(changed.budget.totalInputTokens).toBeLessThan(80_000)
  })

  it('invalidates a provider usage anchor when the model identity changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-builder-provider-switch-'))
    dirs.push(root)
    const ledger = new ModelLedgerStore(root)
    const runtime = new SessionRuntimeCoordinator(ledger)
    const first = await runtime.beginTurn({
      sessionId: 'switch', contextScopeId: 'main', text: 'first', providerId: 'p1', model: 'm1'
    })
    await runtime.recordAssistant(first, {
      content: 'answer', usage: { inputTokens: 10_000, outputTokens: 100, totalTokens: 10_100 }
    })
    await runtime.completeTurn(first, { stopReason: 'stop' })
    await runtime.beginTurn({
      sessionId: 'switch', contextScopeId: 'main', text: 'second', providerId: 'p2', model: 'm2'
    })

    const scope = (await ledger.load('switch')).scopes.main
    expect(scope.lastProviderUsage).toBeUndefined()
    expect(scope.lastProviderUsageMessageId).toBeUndefined()
  })

  it('forwards the active user message and effective reasoning reserve to auto compaction', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-builder-auto-compact-'))
    dirs.push(root)
    const ledger = new ModelLedgerStore(root)
    const runtime = new SessionRuntimeCoordinator(ledger)
    const old = await runtime.beginTurn({
      sessionId: 'auto', contextScopeId: 'main', text: 'old request'
    })
    await runtime.recordAssistant(old, { content: 'H'.repeat(35_000) })
    await runtime.completeTurn(old, { stopReason: 'stop' })
    const current = await runtime.beginTurn({
      sessionId: 'auto', contextScopeId: 'main', text: 'finish this request'
    })
    const compact = vi.fn().mockResolvedValue({ status: 'failed' })
    const builder = new ModelContextBuilder(
      ledger,
      undefined,
      undefined,
      undefined,
      { compact } as any
    )

    await expect(builder.build({
      sessionId: 'auto',
      contextScopeId: 'main',
      currentInputMessageId: current.userMessageId,
      currentInput: current.inputText,
      capabilities: {
        contextWindowTokens: 10_000,
        maxOutputTokens: 2_000,
        reasoningCountsAgainstContext: true
      },
      systemPrompt: 'system',
      toolSchemas: [],
      reasoningBudgetTokens: 1_234,
      workspaceRoot: root
    })).rejects.toMatchObject({ code: 'BUDGET_UNAVAILABLE' })

    expect(compact).toHaveBeenCalledWith(expect.objectContaining({
      trigger: 'auto_threshold',
      requiredMessageId: current.userMessageId,
      reasoningBudgetTokens: 1_234,
      workspaceRoot: root
    }))
  })
})
