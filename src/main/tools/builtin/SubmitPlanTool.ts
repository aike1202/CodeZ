import { Tool, ToolContext } from '../Tool'
import { PlanService } from '../../services/PlanService'

interface SubmitPlanStepInput {
  title: string
  description: string
  files?: string[]
}

interface SubmitPlanArgs {
  title: string
  description: string
  steps: SubmitPlanStepInput[]
}

export class SubmitPlanTool extends Tool {
  get name() {
    return 'SubmitPlan'
  }

  get description() {
    return 'Submit a structured plan for user approval. Call this after exploring and designing in Plan Mode. Include a title, description, and steps (each step: goal + files + acceptance criteria, 50-150 chars). The user will Approve or Request Changes. Once approved, use UpdatePlanStep to track progress during execution.'
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
    let parsed: SubmitPlanArgs
    try {
      parsed = JSON.parse(args) as SubmitPlanArgs
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
