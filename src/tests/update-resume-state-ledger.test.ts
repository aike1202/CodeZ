import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { UpdateResumeStateTool } from '../main/tools/builtin/UpdateResumeStateTool'
import { ModelLedgerStore } from '../main/services/context/ModelLedgerStore'
import { SessionRuntimeCoordinator } from '../main/services/context/SessionRuntimeCoordinator'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('update_resume_state canonical persistence', () => {
  it('writes an explicit versioned state to the active ledger turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-resume-tool-'))
    dirs.push(root)
    const ledger = new ModelLedgerStore(root)
    const coordinator = new SessionRuntimeCoordinator(ledger)
    const turn = await coordinator.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: 'save progress'
    })
    await coordinator.recordAssistant(turn, {
      content: '', toolCalls: [{ id: 'resume-1', name: 'update_resume_state', arguments: '{}' }]
    })

    const output = await new UpdateResumeStateTool().execute(JSON.stringify({
      currentGoalId: 'goal-1', currentPhase: 'implementation', currentStep: 'ledger',
      nextAction: 'run tests', filesTouched: ['src/a.ts']
    }), {
      workspaceRoot: root,
      sessionId: 's1',
      runtimeCoordinator: coordinator,
      runtimeTurn: turn
    })
    await coordinator.recordToolResult(turn, {
      callId: 'resume-1', name: 'update_resume_state', content: output, status: 'success'
    })
    await coordinator.completeTurn(turn, { stopReason: 'tool_calls' })

    expect((await ledger.load('s1')).scopes.main.resumeState).toMatchObject({
      source: 'explicit_tool',
      revision: 1,
      state: { currentGoalId: 'goal-1', currentStep: 'ledger', nextAction: 'run tests' }
    })
  })

  it('does not fall back to an independent resume-state file', async () => {
    await expect(new UpdateResumeStateTool().execute(JSON.stringify({
      currentPhase: 'work', currentStep: 'step', nextAction: 'next'
    }), { workspaceRoot: process.cwd(), sessionId: 's1' })).rejects.toThrow(
      'requires the canonical model ledger runtime'
    )
  })
})
