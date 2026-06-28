import * as fs from 'fs/promises'
import * as path from 'path'

export type VerificationPriority = 'high' | 'medium' | 'low'

export interface VerificationRecommendation {
  command: string
  reason: string
  priority: VerificationPriority
}

export class VerificationStrategyService {
  static async readPackageScripts(workspaceRoot: string): Promise<Record<string, string>> {
    try {
      const packageJsonPath = path.join(workspaceRoot, 'package.json')
      const content = await fs.readFile(packageJsonPath, 'utf-8')
      const parsed = JSON.parse(content)
      return parsed?.scripts && typeof parsed.scripts === 'object' ? parsed.scripts : {}
    } catch {
      return {}
    }
  }

  static getAvailableVerificationCommands(scripts: Record<string, string>): string[] {
    const commands: string[] = []
    if (scripts.test) commands.push('npm run test')
    if (scripts.typecheck) commands.push('npm run typecheck')
    if (scripts.lint) commands.push('npm run lint')
    if (scripts.build) commands.push('npm run build')
    return commands
  }

  static recommend(changedFiles: string[], scripts: Record<string, string>): VerificationRecommendation[] {
    const normalized = changedFiles.map((file) => file.replace(/\\/g, '/'))
    const recommendations: VerificationRecommendation[] = []
    const add = (scriptName: string, reason: string, priority: VerificationPriority) => {
      if (!scripts[scriptName]) return
      const command = `npm run ${scriptName}`
      if (recommendations.some((item) => item.command === command)) return
      recommendations.push({ command, reason, priority })
    }

    const hasSource = normalized.some((file) => file.startsWith('src/'))
    const hasMain = normalized.some((file) => file.startsWith('src/main/'))
    const hasAgent = normalized.some((file) => file.startsWith('src/main/agent/'))
    const hasTools = normalized.some((file) => file.startsWith('src/main/tools/'))
    const hasChat = normalized.some((file) => file.startsWith('src/main/services/chat/'))
    const hasRenderer = normalized.some((file) => file.startsWith('src/renderer/'))
    const docsOnly = normalized.length > 0 && normalized.every((file) => /(^|\/)(docs|docsv2|\.continue)\//.test(file) || /\.(md|mdx)$/i.test(file))

    if (docsOnly) {
      return [{ command: 'skip', reason: 'Only documentation files changed; full build is usually not required unless requested.', priority: 'low' }]
    }

    if (hasAgent) add('test', 'Agent runtime changed; run tests covering loop and tool result behavior.', 'high')
    if (hasTools) add('test', 'Tool implementation changed; run tool and integration tests.', 'high')
    if (hasChat) add('test', 'Provider/chat adapter changed; run chat service tests.', 'high')
    if (hasMain || hasRenderer || hasSource) add('typecheck', 'TypeScript source changed; run type checking.', 'high')
    if (hasRenderer) add('build', 'Renderer/UI code changed; run production build to catch bundling issues.', 'medium')
    if (hasSource && recommendations.length === 0) add('test', 'Source files changed; run project tests.', 'medium')

    return recommendations
  }

  static formatPromptSection(scripts: Record<string, string>): string {
    const available = VerificationStrategyService.getAvailableVerificationCommands(scripts)
    if (available.length === 0) return ''

    return [
      '  【VERIFICATION STRATEGY】',
      '  After modifying files, choose the smallest relevant verification commands instead of always running the heaviest command.',
      '  Available verification commands in this project:',
      ...available.map((command) => `  - ${command}`),
      '  Recommendation rules:',
      '  - src/main/tools/* or src/main/agent/* changes: run npm run test and npm run typecheck when available.',
      '  - src/renderer/* changes: run npm run typecheck and npm run build when available.',
      '  - docs-only changes: state that full build is not required unless the user asks.',
      '  If verification fails, use the real command output to fix the issue, then verify again. Do not claim completion if verification failed or was skipped.'
    ].join('\n')
  }
}
