import { Tool, ToolContext } from '../Tool'

export interface AskUserOption {
  label: string
  description?: string
  preview?: string
}
export interface AskUserQuestionItem {
  question: string
  header: string
  options: AskUserOption[]
  multiSelect?: boolean
}
export interface AskUserRequest {
  id: string
  questions: AskUserQuestionItem[]
}
export interface AskUserAnswer {
  question: string
  answer: string | string[]
}

export type AskUserHandler = (req: AskUserRequest) => Promise<AskUserAnswer[]>

export function validateAskUserRequest(parsed: any): { ok: true; questions: AskUserQuestionItem[] } | { ok: false; error: string } {
  const qs = parsed?.questions
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 4) {
    return { ok: false, error: 'questions must be an array of 1-4 items.' }
  }
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i]
    if (!q || typeof q.question !== 'string' || !q.question) {
      return { ok: false, error: `questions[${i}].question is required.` }
    }
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
      return { ok: false, error: `questions[${i}].options must have 2-4 items.` }
    }
  }
  return { ok: true, questions: qs as AskUserQuestionItem[] }
}

export async function interceptAskUser(
  name: string,
  parsedArgs: any,
  id: string,
  handler: AskUserHandler | null
): Promise<{ handled: boolean; result?: string; isError?: boolean }> {
  if (name !== 'AskUserQuestion') return { handled: false }
  const v = validateAskUserRequest(parsedArgs)
  if (!v.ok) return { handled: true, result: `Error: ${v.error}`, isError: true }
  if (!handler) return { handled: true, result: 'Error: No ask-user handler registered.', isError: true }
  try {
    const answers = await handler({ id, questions: v.questions })
    return { handled: true, result: JSON.stringify(answers) }
  } catch (e: any) {
    return { handled: true, result: `Error: ${e.message}`, isError: true }
  }
}

interface AskUserArgs {
  questions?: AskUserQuestionItem[]
}

export class AskUserQuestionTool extends Tool {
  get name() {
    return 'AskUserQuestion'
  }

  get description() {
    return 'Use only when blocked on a decision genuinely the user\'s to make (one you cannot resolve from the request/code/sensible defaults). Users can always select "Other" for custom input; multiSelect allows multiple answers. Put the recommended option first and suffix its label with "(Recommended)". Reserve for decisions where the answer changes what you do next. 1-4 questions, each with 2-4 options. preview (single-select only) shows an ASCII/code mockup side-by-side. Do NOT ask "Is my plan ready?" — this is not plan mode.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              header: { type: 'string', description: 'Very short label (max ~12 chars).' },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                    preview: { type: 'string' }
                  },
                  required: ['label']
                }
              },
              multiSelect: { type: 'boolean' }
            },
            required: ['question', 'header', 'options']
          }
        }
      },
      required: ['questions']
    }
  }

  async execute(args: string, _context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as AskUserArgs
      const v = validateAskUserRequest(parsed)
      if (!v.ok) return `Error: ${v.error}`
      return JSON.stringify({ questions: v.questions })
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }
}
