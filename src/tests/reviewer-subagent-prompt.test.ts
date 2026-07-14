import { describe, expect, it } from 'vitest'
import { ReviewerSubAgent } from '../main/agent/definitions/ReviewerSubAgent'
import { ToolManager } from '../main/tools/ToolManager'

describe('Reviewer subagent prompt', () => {
  it('advertises an independent completion review rather than general exploration', () => {
    expect(ReviewerSubAgent.type).toBe('Reviewer')
    expect(ReviewerSubAgent.description).toContain('Independent read-only reviewer')
    expect(ReviewerSubAgent.whenToUse).toContain('before reporting completion')
    expect(ReviewerSubAgent.whenNotToUse).toContain('General codebase exploration')
    expect(ReviewerSubAgent.allowShell).not.toBe(true)
    expect(ReviewerSubAgent.shellPolicy).toBeUndefined()
    expect(ReviewerSubAgent.outputSpec?.fields.map(field => field.name)).toEqual(
      expect.arrayContaining([
        'verdict',
        'reviewCycleId',
        'reviewMode',
        'report',
        'conclusion',
        'confidence',
        'blockingFindings',
        'risks',
        'resolvedFindingIds',
        'checksRun',
        'filesExamined',
        'unresolvedCount',
      ]),
    )
  })

  it('exposes only dedicated read-only inspection tools', () => {
    const names = ReviewerSubAgent.getTools(new ToolManager()).map(tool => tool.function.name)

    expect(names).toEqual(expect.arrayContaining(['Read', 'list_files', 'Glob', 'Grep']))
    expect(names).not.toEqual(expect.arrayContaining([
      'Bash',
      'PowerShell',
      'Edit',
      'Write',
      'NotebookEdit',
    ]))
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
      reviewMode: 'initial',
      reviewCycleId: 'draft-persistence',
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
    expect(prompt).toContain('independent implementation acceptance reviewer')
    expect(prompt).toContain('Original user goal and acceptance criteria')
    expect(prompt).toContain('Complete list of files changed')
    expect(prompt).toContain('Verification commands already run')
    expect(prompt).toContain('Blocking evidence threshold')
    expect(prompt).toContain('not to maximize findings')
    expect(prompt).toContain('Do not add new completion criteria')
    expect(prompt).toContain('Do not create, edit, delete, move, or copy project files')
    expect(prompt).toContain('Call submit_result exactly once')
    expect(prompt).toContain('PASS, PASS_WITH_RISKS, or BLOCKED')
    expect(prompt).toContain('malformed legacy data')
    expect(prompt).not.toContain('Bash')
    expect(prompt).not.toContain('PowerShell')
    expect(prompt).not.toContain('run focused tests')
  })

  it('rejects invalid verdicts and evidence-free submissions', () => {
    const validate = ReviewerSubAgent.validateStructuredOutput!
    const initialContext = {
      reviewMode: 'initial' as const,
      reviewCycleId: 'draft-persistence',
    } as any
    const base = {
      reviewCycleId: 'draft-persistence',
      reviewMode: 'initial',
      report: 'Review report',
      conclusion: 'Review conclusion',
      confidence: 'high' as const,
      blockingFindings: [],
      risks: [],
      resolvedFindingIds: [],
      checksRun: ['npm test: passed'],
      filesExamined: ['src/drafts.ts'],
      unresolvedCount: 0,
    }

    expect(validate({ ...base, verdict: 'OK' } as any, initialContext)).toContain('verdict')
    expect(validate({ ...base, verdict: 'PASS', checksRun: [] } as any, initialContext)).toContain('checksRun')
    expect(validate({ ...base, verdict: 'PASS', filesExamined: [] } as any, initialContext)).toContain('filesExamined')
    expect(validate({ ...base, verdict: 'PASS', risks: ['P2 hardening'] } as any, initialContext)).toContain('PASS')
    expect(validate({ ...base, verdict: 'PASS', unresolvedCount: 1 } as any, initialContext)).toContain('PASS')
    expect(validate({ ...base, verdict: 'PASS_WITH_RISKS' } as any, initialContext)).toContain('risk')
    expect(validate({ ...base, verdict: 'BLOCKED' } as any, initialContext)).toContain('blocking')
    expect(validate({ ...base, verdict: 'PASS' } as any, initialContext)).toBeUndefined()
    expect(validate({
      ...base,
      verdict: 'PASS_WITH_RISKS',
      risks: ['P2: malformed legacy data was not independently executed.'],
    } as any, initialContext)).toBeUndefined()
  })

  it('allows only evidence-backed P0/P1 blockers and closes the same IDs', () => {
    const validate = ReviewerSubAgent.validateStructuredOutput!
    const finding = {
      id: 'F-001',
      criterionId: 'AC-1',
      severity: 'P1',
      location: 'src/drafts.ts:42',
      expected: 'Draft survives restart.',
      actual: 'Draft is held only in memory.',
      reproduction: 'Create a draft, restart, and load the draft list.',
      evidence: 'src/drafts.ts:42 stores drafts in a module-level Map.',
      confidence: 'high',
    }
    const base = {
      reviewCycleId: 'draft-persistence',
      report: 'Review report',
      conclusion: 'Review conclusion',
      confidence: 'high',
      risks: [],
      checksRun: ['Read src/drafts.ts.'],
      filesExamined: ['src/drafts.ts'],
      unresolvedCount: 0,
    }

    expect(validate({
      ...base,
      reviewMode: 'initial',
      verdict: 'BLOCKED',
      blockingFindings: [finding],
      resolvedFindingIds: [],
    } as any, {
      reviewMode: 'initial', reviewCycleId: 'draft-persistence',
    } as any)).toBeUndefined()

    const closureContext = {
      reviewMode: 'closure',
      reviewCycleId: 'draft-persistence',
      previousFindingIds: ['F-001'],
    } as any
    expect(validate({
      ...base,
      reviewMode: 'closure',
      verdict: 'PASS',
      blockingFindings: [],
      resolvedFindingIds: ['F-001'],
    } as any, closureContext)).toBeUndefined()
    expect(validate({
      ...base,
      reviewMode: 'closure',
      verdict: 'BLOCKED',
      blockingFindings: [{ ...finding, id: 'F-NEW' }],
      resolvedFindingIds: ['F-001'],
    } as any, closureContext)).toContain('new finding IDs')
  })
})
