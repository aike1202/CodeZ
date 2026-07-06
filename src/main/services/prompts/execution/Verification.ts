import type { PromptModule, PromptContext } from '../PromptTypes'
import { VerificationStrategyService } from '../../VerificationStrategyService'

export const VerificationModule: PromptModule = {
  id: 'verification',
  layer: 'execution',
  priority: 2,
  build: async (ctx: PromptContext) => {
    const scripts = await VerificationStrategyService.readPackageScripts(ctx.workspaceRoot)
    const section = VerificationStrategyService.formatPromptSection(scripts)
    if (!section) return ''
    return section
  },
}
