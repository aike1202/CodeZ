import { describe, expect, it } from 'vitest'
import { ToolManager } from '../main/tools/ToolManager'
import { ToolExposureState } from '../main/tools/runtime/ToolExposurePlanner'

describe('ToolExposurePlanner', () => {
  it('keeps core tools eager and low-frequency tools deferred', () => {
    const manager = new ToolManager()
    const plan = manager.createExposurePlan()
    const eager = new Set(plan.eagerTools.map((tool) => tool.name))
    const deferred = new Set(plan.deferredTools.map((tool) => tool.name))
    expect(eager.has('Read')).toBe(true)
    expect(eager.has('Edit')).toBe(true)
    expect(eager.has('AskUserQuestion')).toBe(true)
    expect(eager.has('Skill')).toBe(true)
    expect(deferred.has('Skill')).toBe(false)
    expect(deferred.has('WebSearch')).toBe(true)
    expect(deferred.has('NotebookEdit')).toBe(true)
  })

  it('activates deferred tools for the next plan', () => {
    const manager = new ToolManager()
    const plan = manager.createExposurePlan({ activatedDeferredTools: new Set(['WebSearch']) })
    expect(plan.eagerTools.some((tool) => tool.name === 'WebSearch')).toBe(true)
  })

  it('restores persisted activations before building a session prompt', () => {
    const state = new ToolExposureState()
    state.restoreSession('session-1', {
      main: ['WebSearch'],
      'subagent:worker-1': ['NotebookEdit']
    })

    expect([...state.get('session-1:main')]).toEqual(['WebSearch'])
    expect([...state.get('session-1:subagent:worker-1')]).toEqual(['NotebookEdit'])
  })
})
