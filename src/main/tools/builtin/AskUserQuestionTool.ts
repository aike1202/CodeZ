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
    return `Use this tool only when you are blocked on a decision that is genuinely the user's to make: one you cannot resolve from the request, the code, or sensible defaults. Usage notes: - Users can always select "Other" to provide custom text input. - Use multiSelect: true to allow multiple answers to a selected for a question. - If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label. Plan mode note: To switch into plan mode, use EnterPlanMode (not this tool). Once in plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?", "Should I proceed?", or otherwise reference "the plan" in questions — the user cannot see the plan until you call ExitPlanMode for approval. Reserve this for decisions where the user's answer changes what you do next — not for choices with a conventional default or facts you can verify in the codebase yourself. In those cases pick the obvious option, mention it in your response, and proceed. Preview feature: Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare — ASCII mockups of UI layouts or components, code snippets showing different implementations, diagram variations, configuration examples. Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`
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
