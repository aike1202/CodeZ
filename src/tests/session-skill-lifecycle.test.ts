import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { ActivateSkillTool } from '../main/tools/builtin/SkillTool'
import { DeactivateSkillTool } from '../main/tools/builtin/DeactivateSkillTool'
import { ModelContextBuilder } from '../main/services/context/ModelContextBuilder'
import { ModelLedgerStore } from '../main/services/context/ModelLedgerStore'
import { SessionRuntimeCoordinator } from '../main/services/context/SessionRuntimeCoordinator'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codez-session-skill-'))
  roots.push(root)
  const skillDir = path.join(root, '.skills', 'review')
  await mkdir(skillDir, { recursive: true })
  await writeFile(path.join(skillDir, 'SKILL.md'), [
    '---',
    'name: Review',
    'description: Review changes carefully',
    '---',
    'Follow the durable review workflow.'
  ].join('\n'), 'utf8')
  const ledgerRoot = path.join(root, 'runtime')
  const ledger = new ModelLedgerStore(ledgerRoot)
  const coordinator = new SessionRuntimeCoordinator(ledger)
  const turn = await coordinator.beginTurn({
    sessionId: 's1', contextScopeId: 'main', text: 'review this change'
  })
  return { root, ledgerRoot, ledger, coordinator, turn }
}

describe('session skill lifecycle', () => {
  it('persists activation, reuses unchanged content, and honors session disable', async () => {
    const f = await fixture()
    const activate = new ActivateSkillTool()
    const deactivate = new DeactivateSkillTool()
    const context = {
      workspaceRoot: f.root,
      sessionId: 's1',
      contextScopeId: 'main' as const,
      runtimeCoordinator: f.coordinator,
      runtimeTurn: f.turn
    }

    await f.coordinator.recordAssistant(f.turn, {
      content: '',
      toolCalls: [{ id: 'activate-1', name: 'ActivateSkill', arguments: '{"skill":"Review"}' }]
    })
    const first = await activate.execute('{"skill":"Review"}', context)
    expect(first).toContain('<command-name>Review</command-name>')
    expect((await f.ledger.load('s1')).scopes.main.skillStates).toEqual([
      expect.objectContaining({ name: 'Review', status: 'active', source: 'model' })
    ])
    await f.coordinator.recordToolResult(f.turn, {
      callId: 'activate-1', name: 'ActivateSkill', status: 'success',
      content: JSON.stringify({ ok: true, data: first })
    })

    const repeated = await activate.execute('{"skill":"Review"}', context)
    expect(JSON.parse(repeated)).toMatchObject({
      type: 'skill_state', status: 'already_active', skill: 'Review'
    })

    const disabled = await deactivate.execute(JSON.stringify({
      skill: 'Review', mode: 'disabled', reason: 'User opted out'
    }), context)
    expect(JSON.parse(disabled)).toMatchObject({ status: 'disabled', skill: 'Review' })
    expect((await f.ledger.load('s1')).scopes.main.skillStates?.[0]).toMatchObject({
      name: 'Review', status: 'disabled', reason: 'User opted out'
    })

    expect(await activate.execute('{"skill":"Review"}', context))
      .toContain('disabled for this conversation')
    expect(await activate.execute('{"skill":"Review","force":true}', context))
      .toContain('<command-name>Review</command-name>')
    expect((await f.ledger.load('s1')).scopes.main.skillStates?.[0].status).toBe('active')
  })

  it('restores an activation event even when the app stops before its tool result', async () => {
    const f = await fixture()
    await f.coordinator.recordAssistant(f.turn, {
      content: '',
      toolCalls: [{ id: 'activate-crash', name: 'ActivateSkill', arguments: '{"skill":"Review"}' }]
    })
    await new ActivateSkillTool().execute('{"skill":"Review"}', {
      workspaceRoot: f.root,
      sessionId: 's1',
      contextScopeId: 'main',
      runtimeCoordinator: f.coordinator,
      runtimeTurn: f.turn
    })

    const restartedLedger = new ModelLedgerStore(f.ledgerRoot)
    const restartedRuntime = new SessionRuntimeCoordinator(restartedLedger)
    await restartedRuntime.recoverSession('s1')
    const restored = await restartedLedger.load('s1')
    expect(restored.scopes.main.skillStates?.[0]).toMatchObject({
      name: 'Review', status: 'active'
    })
    expect(restored.scopes.main.activeMessages.at(-1)).toMatchObject({
      role: 'tool', name: 'ActivateSkill', status: 'interrupted'
    })

    const next = await restartedRuntime.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: 'continue'
    })
    const built = await new ModelContextBuilder(restartedLedger).build({
      sessionId: 's1', contextScopeId: 'main',
      currentInputMessageId: next.userMessageId, currentInput: next.inputText,
      capabilities: { contextWindowTokens: 32_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system', toolSchemas: [], allowCompaction: false
    })
    expect(built.items.find((item) => item.kind === 'skill_context')?.message.content)
      .toContain('Follow the durable review workflow.')
  })

  it('injects disabled state before the next user input after restart', async () => {
    const f = await fixture()
    await f.coordinator.updateSkillState(f.turn, {
      name: 'Review', status: 'disabled', source: 'model', reason: 'Do not use it'
    })
    await f.coordinator.completeTurn(f.turn, { stopReason: 'stop' })

    const restartedLedger = new ModelLedgerStore(f.ledgerRoot)
    const restartedRuntime = new SessionRuntimeCoordinator(restartedLedger)
    const next = await restartedRuntime.beginTurn({
      sessionId: 's1', contextScopeId: 'main', text: 'continue without review'
    })
    const built = await new ModelContextBuilder(restartedLedger).build({
      sessionId: 's1', contextScopeId: 'main',
      currentInputMessageId: next.userMessageId, currentInput: next.inputText,
      capabilities: { contextWindowTokens: 32_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system', toolSchemas: [], allowCompaction: false
    })
    const stateItem = built.items.find((item) => item.kind === 'skill_state')
    const inputIndex = built.items.findIndex((item) =>
      'id' in item.message && item.message.id === next.userMessageId
    )
    expect(stateItem?.message.content).toContain('session_skill_state')
    expect(stateItem?.message.content).toContain('disabled')
    expect(built.items.indexOf(stateItem!)).toBeLessThan(inputIndex)
  })

  it('treats an explicit slash expansion as a user activation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-explicit-skill-'))
    roots.push(root)
    const ledger = new ModelLedgerStore(path.join(root, 'runtime'))
    const runtime = new SessionRuntimeCoordinator(ledger)
    await runtime.beginTurn({
      sessionId: 's1', contextScopeId: 'main',
      text: [
        '【本次请求强制应用工作流：Review】',
        '',
        '指令要求如下：',
        'Follow explicit review instructions.',
        '',
        '当前任务参数/问题：',
        'src/main.ts'
      ].join('\n'),
      commandMetadata: { commandName: 'review' }
    })
    expect((await ledger.load('s1')).scopes.main.skillStates?.[0]).toMatchObject({
      name: 'Review', status: 'active', source: 'user', args: 'src/main.ts'
    })
  })
})
