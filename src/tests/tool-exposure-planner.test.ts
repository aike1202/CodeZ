import { describe, expect, it } from 'vitest'
import { ToolManager } from '../main/tools/ToolManager'

describe('ToolExposurePlanner', () => {
  it('keeps core tools eager and low-frequency tools deferred', () => {
    const manager = new ToolManager()
    const plan = manager.createExposurePlan()
    const eager = new Set(plan.eagerTools.map((tool) => tool.name))
    const deferred = new Set(plan.deferredTools.map((tool) => tool.name))
    expect(eager.has('Read')).toBe(true)
    expect(eager.has('Edit')).toBe(true)
    expect(eager.has('AskUserQuestion')).toBe(true)
    expect(deferred.has('WebSearch')).toBe(true)
    expect(deferred.has('NotebookEdit')).toBe(true)
  })

  it('activates deferred tools for the next plan', () => {
    const manager = new ToolManager()
    const plan = manager.createExposurePlan({ activatedDeferredTools: new Set(['WebSearch']) })
    expect(plan.eagerTools.some((tool) => tool.name === 'WebSearch')).toBe(true)
  })
})

