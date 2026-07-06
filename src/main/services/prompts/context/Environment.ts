import type { PromptModule, PromptContext } from '../PromptTypes'
import * as os from 'os'

export const EnvironmentModule: PromptModule = {
  id: 'environment',
  layer: 'context',
  priority: 3,
  build: (ctx: PromptContext) => {
    const platform = process.platform
    const shell = platform === 'win32'
      ? 'PowerShell (primary); Bash tool also available for POSIX scripts'
      : 'Bash'
    const cwd = ctx.workspaceRoot
    const date = new Date().toISOString().slice(0, 10)
    return [
      '- Primary working directory: ' + cwd,
      '- Is a git repository: true',
      `- Platform: ${platform}`,
      `- Shell: ${shell}`,
      `- OS: ${os.type()} ${os.release()}`,
      `- Date: ${date}`,
      `- Model: ${ctx.modelDisplayName} (${ctx.modelId})`,
      `- Context window: ${ctx.contextWindowTokens} tokens`,
      `- Knowledge cutoff: early 2026`
    ].join('\n')
  },
}
