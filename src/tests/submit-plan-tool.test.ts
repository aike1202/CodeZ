import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SubmitPlanTool } from '../main/tools/builtin/SubmitPlanTool'
import { PlanService } from '../main/services/PlanService'

vi.mock('../main/services/PlanService', () => {
  return {
    PlanService: {
      createPlan: vi.fn(),
      submitForReview: vi.fn()
    }
  }
})

describe('SubmitPlanTool', () => {
  let tool: SubmitPlanTool

  beforeEach(() => {
    tool = new SubmitPlanTool()
    vi.clearAllMocks()
  })

  it('should create a plan and submit for review', async () => {
    const mockPlan = {
      slug: 'my-plan',
      title: 'My Plan',
      description: 'Test description',
      steps: []
    }

    ;(PlanService.createPlan as any).mockResolvedValue(mockPlan)
    ;(PlanService.submitForReview as any).mockResolvedValue({
      ...mockPlan,
      status: 'pending_review'
    })

    const args = JSON.stringify({
      title: 'My Plan',
      description: 'Test description',
      steps: [
        { title: 'Step 1', description: 'Desc 1' }
      ]
    })

    const result = await tool.execute(args, { workspaceRoot: '/test/ws' })
    const parsed = JSON.parse(result)

    expect(parsed.ok).toBe(true)
    expect(parsed.data.status).toBe('pending_review')
    expect(parsed.data.plan.slug).toBe('my-plan')

    expect(PlanService.createPlan).toHaveBeenCalledWith(
      '/test/ws',
      'My Plan',
      'Test description',
      [{ title: 'Step 1', description: 'Desc 1' }]
    )
    expect(PlanService.submitForReview).toHaveBeenCalledWith('/test/ws', 'my-plan')
  })

  it('should return error if PlanService throws', async () => {
    ;(PlanService.createPlan as any).mockRejectedValue(new Error('Validation failed'))

    const args = JSON.stringify({
      title: 'My Plan',
      description: 'Test description',
      steps: [{ title: 'Step 1', description: 'Desc 1' }]
    })

    const result = await tool.execute(args, { workspaceRoot: '/test/ws' })
    const parsed = JSON.parse(result)

    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('EXECUTION_ERROR')
    expect(parsed.error.message).toBe('Validation failed')
  })
})
