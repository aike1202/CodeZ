import type { PromptModule, PromptContext } from '../PromptTypes'

const FALLBACK_TEXT = `# Using tools

Prefer dedicated search, read, and edit tools over shell equivalents. Use the shell for commands and operations that dedicated tools cannot express. Tool descriptions define their detailed usage constraints.`

export const ToolPolicyModule: PromptModule = {
  id: 'tool-policy',
  layer: 'dynamic',
  priority: 0,
  build: (ctx: PromptContext) => {
    if (!ctx.availableTools?.length) return FALLBACK_TEXT
    const names = new Set(ctx.availableTools.map(tool => tool.name))
    const lines = ['# Using tools', '']
    if (names.has('Glob') || names.has('Grep') || names.has('Read')) {
      lines.push('- Use the available search and Read tools for repository inspection; their schemas define batching and range behavior.')
    }
    if (names.has('Edit') || names.has('Write')) {
      lines.push('- Prefer one Edit call with an ordered edits array for all known targeted changes to the same existing file. Use Write for new files or intentional full replacements.')
    }
    if (names.has('Bash') || names.has('PowerShell')) {
      lines.push('- Use a shell for commands and operations that dedicated tools cannot express.')
    }
    lines.push('- Use tool names and capabilities from the current schema only; this guidance does not grant unavailable tools.')
    return lines.join('\n')
  },
}
