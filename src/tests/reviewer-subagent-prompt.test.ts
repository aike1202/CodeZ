import { describe, expect, it } from 'vitest'
import { ReviewerSubAgent } from '../main/agent/definitions/ReviewerSubAgent'
import { ToolManager } from '../main/tools/ToolManager'

describe('Reviewer subagent prompt', () => {
  it('advertises an independent completion review rather than general exploration', () => {
    expect(ReviewerSubAgent.type).toBe('Reviewer')
    expect(ReviewerSubAgent.description).toContain('Independent read-only reviewer')
    expect(ReviewerSubAgent.whenToUse).toContain('before reporting completion')
    expect(ReviewerSubAgent.whenNotToUse).toContain('General codebase exploration')
    expect(ReviewerSubAgent.allowShell).toBe(true)
    expect(ReviewerSubAgent.shellPolicy).toBe('verification')
    expect(ReviewerSubAgent.outputSpec?.fields.map(field => field.name)).toEqual(
      expect.arrayContaining([
        'verdict',
        'report',
        'conclusion',
        'confidence',
        'findings',
        'checksRun',
        'filesExamined',
        'unresolvedCount',
      ]),
    )
  })

  it('can inspect and execute checks without exposing file-write tools', () => {
    const names = ReviewerSubAgent.getTools(new ToolManager()).map(tool => tool.function.name)

    expect(names).toEqual(expect.arrayContaining(['Read', 'list_files', 'Glob', 'Grep']))
    expect(names).toEqual(expect.arrayContaining(['Bash', 'PowerShell']))
    expect(names).not.toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit']))
  })

  it('requires the original goal, changed files, independent checks, and a verdict', async () => {
    const prompt = await ReviewerSubAgent.systemPromptBuilder({
      workspaceRoot: '/workspace',
      sessionId: 'session-1',
      task: [
        'Original user goal: preserve drafts across restart.',
        'Actual changes: added durable draft storage.',
        'Files changed: src/drafts.ts, src/drafts.test.ts.',
      ].join('\n'),
      parentPrompt: 'Review the completed draft persistence change.',
      context: 'Primary verification: npm test passed. Known risk: malformed legacy data.',
      apiConfig: {
        baseUrl: 'https://example.invalid',
        apiKey: 'test-key',
        apiFormat: 'openai',
        model: 'test-model',
      },
      contextCapabilities: { contextWindowTokens: 100_000 },
    })

    expect(prompt).toContain('# Using tools')
    expect(prompt).toContain('independent implementation reviewer')
    expect(prompt).toContain('Original user goal and acceptance criteria')
    expect(prompt).toContain('Complete list of files changed')
    expect(prompt).toContain('Verification commands already run')
    expect(prompt).toContain('at least one relevant adversarial probe')
    expect(prompt).toContain('Do not create, edit, delete, move, or copy project files')
    expect(prompt).toContain('Call submit_result exactly once')
    expect(prompt).toContain('PASS, FAIL, or PARTIAL')
    expect(prompt).toContain('malformed legacy data')
  })

  it('rejects invalid verdicts and evidence-free submissions', () => {
    const validate = ReviewerSubAgent.validateStructuredOutput!
    const base = {
      report: 'Review report',
      conclusion: 'Review conclusion',
      confidence: 'high' as const,
      findings: [],
      checksRun: ['npm test: passed'],
      filesExamined: ['src/drafts.ts'],
      unresolvedCount: 0,
    }

    expect(validate({ ...base, verdict: 'OK' } as any)).toContain('verdict')
    expect(validate({ ...base, verdict: 'PASS', checksRun: [] } as any)).toContain('checksRun')
    expect(validate({ ...base, verdict: 'PASS', filesExamined: [] } as any)).toContain('filesExamined')
    expect(validate({ ...base, verdict: 'PASS', findings: ['P2 defect'] } as any)).toContain('PASS')
    expect(validate({ ...base, verdict: 'PASS', unresolvedCount: 1 } as any)).toContain('unresolvedCount')
    expect(validate({ ...base, verdict: 'FAIL' } as any)).toContain('FAIL')
    expect(validate({ ...base, verdict: 'PARTIAL' } as any)).toContain('PARTIAL')
    expect(validate({ ...base, verdict: 'PASS' } as any)).toBeUndefined()
  })
})
