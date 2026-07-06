import { Tool, ToolContext } from '../Tool'

export interface AskUserOption {
  label: string
  description?: string
  /** 选项的详细说明（markdown），可多可少；前端按内容动态展示，支持单选/多选 */
  detail?: string
}
export interface AskUserQuestionItem {
  question: string
  header: string
  options: AskUserOption[]
  multiSelect?: boolean
  /** 自定义"忽略"按钮文案，默认"忽略" */
  ignoreLabel?: string
  /** 自定义"提交"按钮文案，默认"提交" */
  submitLabel?: string
}
/** 用户点击"忽略"时返回的哨兵值，表示拒绝回答该问题 */
export const ASK_USER_IGNORED = '__IGNORED__'
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
    // 可选按钮文案：仅接受 1-16 字符非空字符串，否则忽略该字段
    if (q.ignoreLabel !== undefined) {
      if (typeof q.ignoreLabel !== 'string' || !q.ignoreLabel.trim() || q.ignoreLabel.length > 16) {
        delete q.ignoreLabel
      }
    }
    if (q.submitLabel !== undefined) {
      if (typeof q.submitLabel !== 'string' || !q.submitLabel.trim() || q.submitLabel.length > 16) {
        delete q.submitLabel
      }
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

  get summary() {
    return 'Ask the user a multiple-choice question.'
  }

  get description() {
    return `Use this tool only when you are blocked on a decision that is genuinely the user's to make: one you cannot resolve from the request, the code, or sensible defaults. Usage notes: - Users can always select "Other" to provide custom text input. - Use multiSelect: true to allow multiple answers to a selected for a question. - If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label. - Both single-select and multi-select questions always show a "提交" (submit) button and an "忽略" (ignore) button. For single-select, the user may also confirm by clicking the already-selected option a second time (click once to select, click again to submit). For multi-select, clicking an option toggles its selection and the submit button finalizes all selections. - The user may click "忽略" to decline answering. When they do, the tool returns the sentinel answer "__IGNORED__" for that question. Receiving "__IGNORED__" means the user chose not to answer — do NOT re-ask the same question; instead pick a sensible default yourself or politely continue. - Use the optional ignoreLabel / submitLabel fields to customize the bottom button text (e.g. "跳过", "稍后决定"), max 16 chars; omit to keep defaults. Plan mode note: To switch into plan mode, use EnterPlanMode (not this tool). Once in plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?", "Should I proceed?", or otherwise reference "the plan" in questions — the user cannot see the plan until you call ExitPlanMode for approval. Reserve this for decisions where the user's answer changes what you do next — not for choices with a conventional default or facts you can verify in the codebase yourself. In those cases pick the obvious option, mention it in your response, and proceed. Detail feature: Use the optional \`detail\` field on options to provide a longer explanation of an option — rendered as markdown, so it supports code blocks, lists, bold, tables, etc. Content may be short or long; the UI adapts. When ANY option has a non-empty \`detail\`, the UI switches to a side-by-side layout: a vertical option list on the left and the detail of the currently selected option on the right. This works for BOTH single-select and multiSelect. Use \`detail\` when an option needs more context than a one-line description (e.g. trade-offs, code snippets, step-by-step, configuration examples). For simple preference questions where label + description suffice, omit \`detail\` and the UI stays compact.`
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
                    detail: { type: 'string', description: 'Optional detailed explanation of the option, rendered as markdown. May be short or long; supports code blocks, lists, etc. When any option has detail, the UI shows a side-by-side layout (option list on the left, detail of the currently selected option on the right). Works for both single-select and multiSelect.' }
                  },
                  required: ['label']
                }
              },
              multiSelect: { type: 'boolean' },
              ignoreLabel: { type: 'string', description: 'Custom text for the ignore button (default "忽略"). Max 16 chars.' },
              submitLabel: { type: 'string', description: 'Custom text for the submit button (default "提交"). Max 16 chars.' }
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
