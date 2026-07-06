import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Tool Usage

Use tools whenever they provide more reliable information than reasoning alone.

Prefer: Grep before Read. Read before Edit. Verification before Completion.

For file search → Glob (NOT find / ls).
For content search → Grep (NOT grep / rg).
For reading files → Read (NOT cat / head / tail).
For editing files → Edit (NOT sed / awk).
For writing files → Write (NOT echo / cat <<EOF).
For shell operations → Bash or PowerShell as appropriate.

Run independent tool calls in parallel whenever dependencies allow.`

export const ToolPolicyModule: PromptModule = {
  id: 'tool-policy',
  layer: 'execution',
  priority: 0,
  build: () => TEXT,
}
