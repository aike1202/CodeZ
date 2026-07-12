import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { ModelLedgerStore } from '../main/services/context/ModelLedgerStore'
import { SessionRuntimeCoordinator } from '../main/services/context/SessionRuntimeCoordinator'
import { ModelContextBuilder } from '../main/services/context/ModelContextBuilder'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codez-history-revert-'))
  roots.push(root)
  const ledger = new ModelLedgerStore(root)
  const coordinator = new SessionRuntimeCoordinator(ledger)
  return { root, ledger, coordinator }
}

describe('durable history revert', () => {
  it('removes the target turn and later history, clears usage, and survives reload', async () => {
    const { root, ledger, coordinator } = await fixture()
    const first = await coordinator.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: 'first',
      commandMetadata: { uiMessageId: 'ui-first' }
    })
    await coordinator.recordAssistant(first, { content: 'first answer' })
    await coordinator.completeTurn(first, { stopReason: 'stop' })
    const second = await coordinator.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: 'second',
      commandMetadata: { uiMessageId: 'ui-second' }
    })
    await coordinator.recordAssistant(second, {
      content: 'second answer',
      usage: { inputTokens: 2_000, outputTokens: 100, totalTokens: 2_100 },
      requestFingerprint: 'f'.repeat(64)
    })
    await coordinator.completeTurn(second, { stopReason: 'stop' })

    const plan = await ledger.planHistoryRevert('s1', 'main', 'ui-second')
    const committed = await ledger.appendIfHistoryVersion(
      's1', 'main', plan.expectedHistoryVersion, 'history_reverted', plan.payload
    )

    expect(committed).not.toBeNull()
    const scope = (await ledger.load('s1')).scopes.main
    expect(scope.activeMessages.map((message) => message.content))
      .toEqual(['first', 'first answer'])
    expect(scope.lastProviderUsage).toBeUndefined()
    expect(scope.resumeState).toBeUndefined()

    const reloaded = new ModelLedgerStore(root)
    expect((await reloaded.load('s1')).scopes.main.activeMessages.map((message) => message.content))
      .toEqual(['first', 'first answer'])

    const nextCoordinator = new SessionRuntimeCoordinator(reloaded)
    const next = await nextCoordinator.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: 'replacement',
      commandMetadata: { uiMessageId: 'ui-replacement' }
    })
    const built = await new ModelContextBuilder(reloaded).build({
      sessionId: 's1', contextScopeId: 'main',
      currentInputMessageId: next.userMessageId, currentInput: next.inputText,
      capabilities: { contextWindowTokens: 20_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system', toolSchemas: []
    })
    expect(built.messages.some((message) => message.content === 'second')).toBe(false)
    expect(built.messages.some((message) => message.content === 'second answer')).toBe(false)
  })

  it('uses legacy user-event metadata when normalized history lacks a client id', async () => {
    const { ledger } = await fixture()
    await ledger.append('s1', 'main', 'user_message', {
      message: {
        id: 'u1', turnId: 't1', role: 'user', content: 'legacy', status: 'complete',
        createdAt: '2026-07-12T00:00:00.000Z'
      },
      commandMetadata: { uiMessageId: 'legacy-ui' }
    }, 't1')

    const plan = await ledger.planHistoryRevert('s1', 'main', 'legacy-ui')
    expect(plan.payload.targetMessageId).toBe('u1')
    expect(plan.payload.activeMessages).toEqual([])
  })

  it('refuses a target no longer retained after context replacement', async () => {
    const { ledger, coordinator } = await fixture()
    const turn = await coordinator.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: 'covered',
      commandMetadata: { uiMessageId: 'covered-ui' }
    })
    await coordinator.recordAssistant(turn, { content: 'answer' })
    await coordinator.completeTurn(turn, { stopReason: 'stop' })
    await ledger.append('s1', 'main', 'legacy_import_completed', {
      sourceHash: 'replacement', mode: 'recent-text-fallback', activeMessages: []
    })

    await expect(ledger.planHistoryRevert('s1', 'main', 'covered-ui'))
      .rejects.toMatchObject({ code: 'HISTORY_REVERT_TARGET_COMPACTED' })
  })

  it('blocks maintenance while a turn is active', async () => {
    const { coordinator } = await fixture()
    const turn = await coordinator.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: 'active'
    })
    await expect(coordinator.runIdleScopeMaintenance(
      's1', 'main', async () => undefined
    )).rejects.toMatchObject({ code: 'RUN_ACTIVE' })
    await coordinator.interruptTurn(turn, 'test complete')
  })
})
