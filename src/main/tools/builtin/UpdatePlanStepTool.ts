import { Tool, ToolContext } from '../Tool'
import { PlanService } from '../../services/PlanService'
import type { PlanStepStatus } from '../../../shared/types/plan'

interface UpdatePlanStepArgs {
  slug: string
  stepId: string
  status?: PlanStepStatus
  description?: string
}

export class UpdatePlanStepTool extends Tool {
  get name() {
    return 'UpdatePlanStep'
  }

  get summary() {
    return "Update a plan step's status or details."
  }

  get description() {
    return 'Update a plan step status or description. Use during execution to track progress.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        stepId: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
        description: { type: 'string' }
      },
      required: ['slug', 'stepId']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as UpdatePlanStepArgs;
      
      const updatedPlan = await PlanService.updateStep(
        context.workspaceRoot,
        parsed.slug,
        parsed.stepId,
        {
          status: parsed.status,
          description: parsed.description
        }
      );
      
      // Find the specific step that was updated to return it as the data
      const updatedStep = updatedPlan.steps.find(s => s.id === parsed.stepId);
      
      return JSON.stringify({
        ok: true,
        data: updatedStep || updatedPlan
      });
    } catch (err: any) {
      return JSON.stringify({
        ok: false,
        error: {
          code: 'EXECUTION_ERROR',
          message: err.message
        }
      });
    }
  }
}
