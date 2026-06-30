import { describe, it, expect } from 'vitest'
import { VerificationStrategyService } from '../main/services/VerificationStrategyService'

describe('VerificationStrategyService', () => {
  const scripts = {
    test: 'vitest run',
    typecheck: 'tsc --noEmit',
    build: 'electron-vite build',
    lint: 'eslint .'
  }

  it('应为 tools/agent 源码变更推荐 test 和 typecheck', () => {
    const recommendations = VerificationStrategyService.recommend([
      'src/main/tools/builtin/EditTool.ts',
      'src/main/agent/AgentRunner.ts'
    ], scripts)

    expect(recommendations.map((item) => item.command)).toContain('npm run test')
    expect(recommendations.map((item) => item.command)).toContain('npm run typecheck')
    expect(recommendations.find((item) => item.command === 'npm run test')?.priority).toBe('high')
  })

  it('应为 renderer 变更推荐 typecheck 和 build', () => {
    const recommendations = VerificationStrategyService.recommend([
      'src/renderer/src/components/chat/ChatArea.tsx'
    ], scripts)

    expect(recommendations.map((item) => item.command)).toContain('npm run typecheck')
    expect(recommendations.map((item) => item.command)).toContain('npm run build')
  })

  it('docs only 应跳过完整构建', () => {
    const recommendations = VerificationStrategyService.recommend([
      'docsv2/05-verification-loop.md',
      '.continue/current/task-plan.md'
    ], scripts)

    expect(recommendations).toEqual([
      expect.objectContaining({ command: 'skip', priority: 'low' })
    ])
  })

  it('应根据 scripts 只返回可用命令', () => {
    const recommendations = VerificationStrategyService.recommend([
      'src/renderer/src/App.tsx'
    ], { typecheck: 'tsc --noEmit' })

    expect(recommendations.map((item) => item.command)).toEqual(['npm run typecheck'])
  })

  it('应生成包含最终报告约束的 prompt section', () => {
    const section = VerificationStrategyService.formatPromptSection(scripts)
    expect(section).toContain('VERIFICATION STRATEGY')
    expect(section).toContain('npm run test')
    expect(section).toContain('Do not claim completion')
  })
})
