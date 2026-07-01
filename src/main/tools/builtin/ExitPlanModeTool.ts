import { Tool, ToolContext } from '../Tool'
import { PlanService } from '../../services/PlanService'

interface ExitPlanModeStepInput {
  title: string
  description: string
  files?: string[]
}

interface ExitPlanModeArgs {
  title: string
  description: string
  steps: ExitPlanModeStepInput[]
}

export class ExitPlanModeTool extends Tool {
  get name() {
    return 'ExitPlanMode'
  }

  get description() {
    return 'Submit your plan for user approval. Only call this in Plan Mode after exploring and designing. The user will Approve or Request Changes. Provide a clear title, overall description, and structured steps (each step: goal + files + acceptance criteria, 50-150 chars).'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short readable title for the plan' },
        description: { type: 'string', description: 'Overall goal of the plan' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string', description: '50-150 chars: goal + files + acceptance criteria' },
              files: { type: 'array', items: { type: 'string' } }
            },
            required: ['title', 'description']
          }
        }
      },
      required: ['title', 'description', 'steps']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    let parsed: ExitPlanModeArgs
    try {
      parsed = JSON.parse(args) as ExitPlanModeArgs
    } catch {
      return JSON.stringify({
        ok: false,
        error: { code: 'INVALID_JSON', message: 'Failed to parse arguments as JSON.' }
      })
    }

    if (!parsed.title || !parsed.title.trim()) {
      return JSON.stringify({
        ok: false,
        error: { code: 'MISSING_TITLE', message: 'title is required and cannot be empty.' }
      })
    }
    if (!parsed.description || !parsed.description.trim()) {
      return JSON.stringify({
        ok: false,
        error: { code: 'MISSING_DESCRIPTION', message: 'description is required and cannot be empty.' }
      })
    }
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return JSON.stringify({
        ok: false,
        error: { code: 'MISSING_STEPS', message: 'steps must be a non-empty array.' }
      })
    }

    try {
      const plan = await PlanService.createPlan(
        context.workspaceRoot,
        parsed.title.trim(),
        parsed.description.trim(),
        parsed.steps
      )
      const reviewed = await PlanService.submitForReview(context.workspaceRoot, plan.slug)

      return JSON.stringify({
        ok: true,
        data: {
          planId: reviewed.id,
          slug: reviewed.slug,
          status: 'pending_review',
          plan: reviewed
        }
      })
    } catch (err: any) {
      return JSON.stringify({
        ok: false,
        error: { code: 'EXECUTION_ERROR', message: err.message }
      })
    }
  }
}
