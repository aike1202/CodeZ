import { describe, it, expect, vi, beforeEach } from 'vitest'
import { UpdatePlanStepTool } from '../main/tools/builtin/UpdatePlanStepTool'
import { PlanService } from '../main/services/PlanService'

vi.mock('../main/services/PlanService', () => {
  return {
    PlanService: {
      updateStep: vi.fn()
    }
  }
})

describe('UpdatePlanStepTool', () => {
  let tool: UpdatePlanStepTool

  beforeEach(() => {
    tool = new UpdatePlanStepTool()
    vi.clearAllMocks()
  })

  it('should update a plan step', async () => {
    const mockUpdatedPlan = {
      slug: 'my-plan',
      steps: [
        { id: 'p0', title: 'Step 1', status: 'in_progress', description: 'Working on it' }
      ]
    }
    
    ;(PlanService.updateStep as any).mockResolvedValue(mockUpdatedPlan)

    const args = JSON.stringify({
      slug: 'my-plan',
      stepId: 'p0',
      status: 'in_progress',
      description: 'Working on it'
    })

    const result = await tool.execute(args, { workspaceRoot: '/test/ws' })
    const parsed = JSON.parse(result)

    expect(parsed.ok).toBe(true)
    expect(parsed.data.id).toBe('p0')
    expect(parsed.data.status).toBe('in_progress')
    
    expect(PlanService.updateStep).toHaveBeenCalledWith(
      '/test/ws',
      'my-plan',
      'p0',
      { status: 'in_progress', description: 'Working on it' }
    )
  })

  it('should return the whole plan if step not found (fallback)', async () => {
    const mockUpdatedPlan = {
      slug: 'my-plan',
      steps: [
        { id: 'p1', title: 'Step 1', status: 'pending' }
      ]
    }
    
    ;(PlanService.updateStep as any).mockResolvedValue(mockUpdatedPlan)

    const args = JSON.stringify({
      slug: 'my-plan',
      stepId: 'p0',
      status: 'in_progress'
    })

    const result = await tool.execute(args, { workspaceRoot: '/test/ws' })
    const parsed = JSON.parse(result)

    expect(parsed.ok).toBe(true)
    expect(parsed.data.slug).toBe('my-plan')
  })

  it('should return error if PlanService throws', async () => {
    ;(PlanService.updateStep as any).mockRejectedValue(new Error('Cannot update step'))

    const args = JSON.stringify({
      slug: 'my-plan',
      stepId: 'p0',
      status: 'completed'
    })

    const result = await tool.execute(args, { workspaceRoot: '/test/ws' })
    const parsed = JSON.parse(result)

    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('EXECUTION_ERROR')
    expect(parsed.error.message).toBe('Cannot update step')
  })
})
