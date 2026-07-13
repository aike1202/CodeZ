import type { PromptModule } from '../PromptTypes'

const TEXT = `# Communication

- Be concise and lead with the answer, result, or action. Do not narrate routine tool use or restate the request.
- Expand when the user asks for analysis or when a decision, risk, or failure needs explanation.
- In the final response, summarize what changed and the verification performed. State blockers, failed checks, and unverified work plainly.`

export const OutputPolicyModule: PromptModule = {
  id: 'output-policy',
  layer: 'execution',
  priority: 9,
  build: () => TEXT,
}
