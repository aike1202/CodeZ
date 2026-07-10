import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { ModelHistoryNormalizer } from '../main/services/context/ModelHistoryNormalizer'
import { ModelLedgerStore } from '../main/services/context/ModelLedgerStore'
import { SessionRuntimeCoordinator } from '../main/services/context/SessionRuntimeCoordinator'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('SessionRuntimeCoordinator recovery', () => {
  it('persists interrupted results for a crash-ended tool protocol exactly once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-runtime-recovery-'))
    dirs.push(root)
    const ledger = new ModelLedgerStore(root)
    const firstProcess = new SessionRuntimeCoordinator(ledger)
    const turn = await firstProcess.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: 'inspect files'
    })
    await firstProcess.recordAssistant(turn, {
      content: '',
      toolCalls: [{ id: 'call-1', name: 'Read', arguments: '{"path":"a.ts"}' }]
    })

    const restarted = new SessionRuntimeCoordinator(ledger)
    const firstRecovery = await restarted.recoverSession('s1')
    expect(firstRecovery.recoveredScopes).toEqual([{
      contextScopeId: 'main', turnId: turn.turnId, interruptedToolCalls: 1
    }])

    const recoveredScope = (await ledger.load('s1')).scopes.main
    expect(recoveredScope.activeMessages.map((message) => message.role)).toEqual([
      'user', 'assistant', 'tool'
    ])
    expect(recoveredScope.activeMessages.at(-1)?.status).toBe('interrupted')
    expect(recoveredScope.lastInterruptedTurnId).toBe(turn.turnId)
    expect(() => ModelHistoryNormalizer.assertProtocolInvariant(recoveredScope.activeMessages)).not.toThrow()

    const secondRecovery = await restarted.recoverSession('s1')
    expect(secondRecovery.recoveredScopes).toEqual([])
    expect((await ledger.load('s1')).scopes.main.activeMessages).toHaveLength(3)
  })
})
