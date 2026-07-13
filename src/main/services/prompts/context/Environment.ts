import type { PromptModule, PromptContext } from '../PromptTypes'
import * as os from 'os'

function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

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
    const date = formatLocalDate(ctx.now || new Date())
    return [
      '# Environment',
      '- Primary working directory: ' + cwd,
      `- Platform: ${platform}`,
      `- Shell: ${shell}`,
      `- OS: ${os.type()} ${os.release()}`,
      `- Date: ${date}`,
      `- Model: ${ctx.modelDisplayName} (${ctx.modelId})`,
      `- Context window: ${ctx.contextWindowTokens} tokens`,
      ctx.apiFormat ? `- API format: ${ctx.apiFormat}` : '',
      ctx.permissionMode ? `- Permission mode: ${ctx.permissionMode}` : '',
      ctx.thinkingEnabled !== undefined
        ? `- Extended thinking: ${ctx.thinkingEnabled ? 'enabled' : 'disabled'}`
        : ''
    ].filter(Boolean).join('\n')
  },
}
