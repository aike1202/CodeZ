import type { PromptModule, PromptContext } from '../PromptTypes'

export const VerificationStrategyModule: PromptModule = {
  id: 'verification-strategy',
  layer: 'context',
  priority: 6,
  build: async (ctx: PromptContext) => {
    const { VerificationStrategyService } = await import('../../VerificationStrategyService')
    const scripts = await VerificationStrategyService.readPackageScripts(ctx.workspaceRoot)
    return VerificationStrategyService.formatPromptSection(scripts) || ''
  }
}
