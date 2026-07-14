import type {
  SubAgentContext,
  SubAgentDefinition,
  SubAgentStructuredOutput,
} from '../SubAgentManager'
import { buildSharedToolUsePrompt } from '../../services/prompts/SubAgentPrompts'

function validateReviewerOutput(
  output: SubAgentStructuredOutput,
  ctx: SubAgentContext
): string | undefined {
  const result = output as unknown as Record<string, unknown>
  const verdict = String(result.verdict)
  if (!['PASS', 'PASS_WITH_RISKS', 'BLOCKED'].includes(verdict)) {
    return 'verdict must be exactly "PASS", "PASS_WITH_RISKS", or "BLOCKED".'
  }
  if (String(result.reviewCycleId) !== ctx.reviewCycleId) {
    return 'reviewCycleId must exactly match the caller-provided review cycle.'
  }
  if (String(result.reviewMode) !== ctx.reviewMode) {
    return 'reviewMode must exactly match the caller-provided review mode.'
  }
  if (!Array.isArray(result.checksRun) || result.checksRun.length === 0) {
    return 'checksRun must include at least one read-only inspection or an explicit BLOCKED entry.'
  }
  if (!Array.isArray(result.filesExamined) || result.filesExamined.length === 0) {
    return 'filesExamined must identify the project evidence inspected during review.'
  }
  if (!Number.isInteger(result.unresolvedCount) || Number(result.unresolvedCount) < 0) {
    return 'unresolvedCount must be a non-negative integer.'
  }
  const blockingFindings = Array.isArray(result.blockingFindings)
    ? result.blockingFindings as Array<Record<string, unknown>>
    : []
  const risks = Array.isArray(result.risks) ? result.risks as string[] : []
  const resolvedFindingIds = Array.isArray(result.resolvedFindingIds)
    ? result.resolvedFindingIds as string[]
    : []
  const findingIds = blockingFindings.map((finding) => String(finding.id || ''))

  if (new Set(findingIds).size !== findingIds.length) {
    return 'blockingFindings must use unique stable IDs.'
  }
  for (const finding of blockingFindings) {
    if (!/^F-[A-Z0-9][A-Z0-9._-]*$/i.test(String(finding.id || ''))) {
      return 'Each blocking finding id must be stable and start with "F-".'
    }
    if (!/^AC-\d+$/.test(String(finding.criterionId || ''))) {
      return 'Each blocking finding must cite a frozen acceptance criterion such as "AC-1".'
    }
    for (const field of ['location', 'expected', 'actual', 'reproduction', 'evidence']) {
      if (String(finding[field] || '').trim().length < 3) {
        return `Each blocking finding must include concrete ${field}.`
      }
    }
    if (!['P0', 'P1'].includes(String(finding.severity)) || finding.confidence !== 'high') {
      return 'Only high-confidence P0/P1 findings may block completion.'
    }
  }

  if (verdict === 'BLOCKED' && blockingFindings.length === 0) {
    return 'BLOCKED requires at least one evidence-backed P0/P1 blocking finding.'
  }
  if (verdict !== 'BLOCKED' && blockingFindings.length > 0) {
    return `${verdict} cannot include blocking findings.`
  }
  if (verdict === 'PASS' && (risks.length > 0 || Number(result.unresolvedCount) !== 0)) {
    return 'PASS requires no residual risks and unresolvedCount zero.'
  }
  if (
    verdict === 'PASS_WITH_RISKS' &&
    risks.length === 0 &&
    Number(result.unresolvedCount) === 0
  ) {
    return 'PASS_WITH_RISKS must identify at least one non-blocking risk or unresolved check.'
  }

  if (resolvedFindingIds.some((id) => !/^F-[A-Z0-9][A-Z0-9._-]*$/i.test(id))) {
    return 'resolvedFindingIds must contain stable IDs beginning with "F-".'
  }
  if (new Set(resolvedFindingIds).size !== resolvedFindingIds.length) {
    return 'resolvedFindingIds must not contain duplicates.'
  }
  if (resolvedFindingIds.some((id) => findingIds.includes(id))) {
    return 'A finding cannot be both resolved and blocking.'
  }

  if (ctx.reviewMode === 'initial' && resolvedFindingIds.length > 0) {
    return 'Initial review cannot resolve findings from an earlier round.'
  }
  if (ctx.reviewMode === 'closure') {
    const previousIds = ctx.previousFindingIds || []
    if (previousIds.length === 0) {
      return 'Closure review requires the original blocking finding IDs.'
    }
    const previous = new Set(previousIds)
    const dispositioned = new Set([...findingIds, ...resolvedFindingIds])
    if ([...dispositioned].some((id) => !previous.has(id))) {
      return 'Closure review cannot introduce new finding IDs.'
    }
    if ([...previous].some((id) => !dispositioned.has(id))) {
      return 'Closure review must resolve or reopen every original finding ID.'
    }
  }
  return undefined
}

function buildReviewerRolePrompt(ctx: SubAgentContext): string {
  const suppliedContext = ctx.context
    ? [
        '## Additional Supplied Context',
        ctx.context,
        '',
        'Treat this as context from the implementer, not as proof that the change is correct.',
      ].join('\n')
    : ''

  const scopeSection = ctx.scope
    ? [
        '## Review Scope',
        ctx.scope.directories?.length
          ? `- Prioritize these directories: ${ctx.scope.directories.join(', ')}`
          : '',
        ctx.scope.excludeGlobs?.length
          ? `- Exclude only these agreed patterns: ${ctx.scope.excludeGlobs.join(', ')}`
          : '',
      ].filter(Boolean).join('\n')
    : ''

  const reviewModeSection = ctx.reviewMode === 'closure'
    ? [
        '## Review Mode: Closure',
        `- Review cycle: ${ctx.reviewCycleId || '(missing)'}`,
        `- Original finding IDs: ${(ctx.previousFindingIds || []).join(', ') || '(missing)'}`,
        '- This is the only follow-up review. Use the existing review history and inspect only the fixes for the original findings plus regressions directly caused by those fixes.',
        '- For every original finding ID, either place it in resolvedFindingIds or return it in blockingFindings with updated evidence.',
        '- Do not introduce a new finding ID. A regression caused by a fix reopens the related original finding ID.',
        '- Do not repeat the full repository audit or broaden the acceptance criteria.',
      ].join('\n')
    : [
        '## Review Mode: Initial',
        `- Review cycle: ${ctx.reviewCycleId || '(missing)'}`,
        '- Perform one independent review against the frozen acceptance criteria.',
        '- Assign stable finding IDs beginning with F-. Leave resolvedFindingIds empty.',
      ].join('\n')

  return [
    'You are an independent implementation acceptance reviewer for CodeZ. Your goal is to decide whether the frozen acceptance criteria are met, not to maximize findings or make the solution ideal.',
    '',
    '## Critical: Review only',
    '- Use only the read-only repository inspection tools provided in this session.',
    '- Do not create, edit, delete, move, or copy project files.',
    '- Do not install dependencies or run Git write operations such as add, commit, checkout, merge, or push.',
    '- Do not delegate to another subagent.',
    '- Treat caller-supplied verification output as supporting evidence only. Cross-check what the reported checks cover against the implementation and tests you inspect.',
    '- Never fix a defect yourself.',
    '- PASS is a normal and desirable result when the supplied evidence supports the frozen criteria. You are not expected to find a problem.',
    '',
    reviewModeSection,
    '',
    '## Required caller brief',
    'The task must provide all applicable sections below:',
    '1. Original user goal and acceptance criteria.',
    '2. Actual changes and implementation approach.',
    '3. Complete list of files changed for this request, distinguishing unrelated pre-existing changes.',
    '4. Verification commands already run and their actual results.',
    '5. Known risks, unresolved items, and any relevant plan or specification path.',
    'The acceptance criteria are frozen for this review and are identified in order as AC-1, AC-2, and so on. Do not add new completion criteria during review.',
    'If evidence is incomplete but there is no demonstrated P0/P1 violation, record it as a non-blocking risk and use PASS_WITH_RISKS.',
    '',
    '## Blocking evidence threshold',
    'A blocking finding is valid only when every condition below is met:',
    '1. It cites one frozen criterion by AC-N identifier.',
    '2. It is within the supplied changed scope.',
    '3. It identifies a specific source or contract location.',
    '4. It states expected versus actual behavior.',
    '5. It provides a concrete counterexample or reproducible failure path.',
    '6. It cites observed repository evidence rather than speculation.',
    '7. It is a high-confidence P0 or P1 correctness defect.',
    'P2/P3 concerns, hardening ideas, future extensibility, style preferences, theoretical possibilities, and requests for more tests without a demonstrated failure are risks or suggestions. They cannot block completion.',
    '',
    '## Review workflow',
    '1. Restate the success criteria from the original goal. Do not replace them with the implementer\'s summary.',
    '2. Inspect the supplied files and relevant diff. Trace affected callers, contracts, error paths, and tests.',
    '3. Check that the implementation covers the entire requested behavior, not merely the polished happy path.',
    '4. Independently inspect the implementation, tests, fixtures, and configuration with the available read-only tools. Do not claim to have rerun caller-reported commands.',
    '5. Analyze a relevant adversarial code path only when it is implied by a frozen criterion or the changed behavior.',
    '6. Classify only proven high-confidence P0/P1 defects as blockingFindings. Put everything else in risks.',
    '7. Use BLOCKED only for evidence-backed blockingFindings, PASS_WITH_RISKS for non-blocking concerns or incomplete evidence, and PASS when the criteria are supported without residual risk.',
    '',
    '## Submission contract',
    'Call submit_result exactly once the review is complete. Provide:',
    '- verdict: PASS, PASS_WITH_RISKS, or BLOCKED.',
    '- reviewCycleId and reviewMode: echo the exact caller-provided review cycle and mode.',
    '- report: findings-first review with expected versus actual behavior and evidence.',
    '- conclusion: one concise sentence the parent can use to decide the next action.',
    '- confidence: high, medium, or low.',
    '- blockingFindings: only structured, high-confidence P0/P1 violations that satisfy the complete evidence threshold.',
    '- risks: non-blocking P2/P3 concerns, suggestions, limitations, or incomplete verification; use an empty array for PASS.',
    '- resolvedFindingIds: empty on initial review; on closure, IDs proven closed by the fix.',
    '- checksRun: read-only inspections performed and caller-supplied command results examined; use a BLOCKED entry when required evidence could not be established.',
    '- filesExamined: files and specifications actually inspected.',
    '- unresolvedCount: number of unresolved review questions.',
    '',
    scopeSection,
    suppliedContext,
    '',
    `Project Workspace: ${ctx.workspaceRoot}`,
    `Review Brief:\n${ctx.task || ctx.parentPrompt}`,
  ].filter(Boolean).join('\n')
}

export const ReviewerSubAgent: SubAgentDefinition = {
  type: 'Reviewer',
  description:
    'Independent read-only reviewer that audits completed changes against the original user goal and returns an evidence-backed verdict.',
  maxLoops: 24,
  finalizationReserveLoops: 3,

  whenToUse: [
    'After implementation changes are complete and primary checks have run, before reporting completion to the user.',
    'To independently audit changed code, configuration, resources, tests, or implementation of a plan/specification.',
    'After an initial BLOCKED verdict, resume that same Reviewer exactly once in closure mode after fixing confirmed blockers.',
  ].join('\n'),
  whenNotToUse: [
    'General codebase exploration, research, or implementation work.',
    'Before the parent Agent has completed the change and gathered the actual changed-file list.',
    'As a substitute for the parent Agent running proportionate primary verification.',
    'Pure question answering or read-only investigation where no project files changed.',
  ].join('\n'),
  costHint:
    'Up to 24 review tool calls. Uses configured candidate models and otherwise follows the main Agent model.',

  getTools: (toolManager) => toolManager.getReadOnlyTools(),

  outputSpec: {
    description: 'Submit the independent review verdict, findings, and verification evidence.',
    fields: [
      {
        name: 'verdict',
        type: 'string',
        description: 'Exactly "PASS", "PASS_WITH_RISKS", or "BLOCKED".',
        required: true,
      },
      {
        name: 'reviewCycleId',
        type: 'string',
        description: 'Exact caller-provided review cycle ID.',
        required: true,
      },
      {
        name: 'reviewMode',
        type: 'string',
        description: 'Exact caller-provided mode: "initial" or "closure".',
        required: true,
      },
      {
        name: 'report',
        type: 'string',
        description: 'Findings-first review with expected versus actual behavior and supporting evidence.',
        required: true,
      },
      {
        name: 'conclusion',
        type: 'string',
        description: 'One concise sentence stating the outcome and required next action.',
        required: true,
      },
      {
        name: 'confidence',
        type: 'string',
        description: '"high", "medium", or "low".',
        required: true,
      },
      {
        name: 'blockingFindings',
        type: 'reviewFinding[]',
        description: 'Only high-confidence P0/P1 violations of frozen acceptance criteria with complete evidence.',
        required: true,
      },
      {
        name: 'risks',
        type: 'string[]',
        description: 'Non-blocking P2/P3 concerns, suggestions, limitations, and incomplete verification.',
        required: true,
      },
      {
        name: 'resolvedFindingIds',
        type: 'string[]',
        description: 'Original finding IDs proven closed during closure review; empty during initial review.',
        required: true,
      },
      {
        name: 'checksRun',
        type: 'string[]',
        description: 'Read-only inspections and supplied verification evidence examined; include BLOCKED reasons.',
        required: true,
      },
      {
        name: 'filesExamined',
        type: 'string[]',
        description: 'Files, plans, and specifications actually examined.',
        required: true,
      },
      {
        name: 'unresolvedCount',
        type: 'number',
        description: 'Number of review questions that remain unresolved.',
        required: true,
      },
    ],
  },

  validateStructuredOutput: validateReviewerOutput,

  systemPromptBuilder: async (ctx): Promise<string> => {
    const tools = ctx.promptTools || ['Read', 'list_files', 'Glob', 'Grep'].map(name => ({
      type: 'function' as const,
      function: { name, description: `${name} tool`, parameters: {} },
    }))
    const sharedPrompt = await buildSharedToolUsePrompt({
      workspaceRoot: ctx.workspaceRoot,
      modelId: ctx.modelOverride || ctx.apiConfig.model,
      modelDisplayName: ctx.modelOverride || ctx.apiConfig.model,
      contextWindowTokens: ctx.contextCapabilities?.contextWindowTokens ?? 1,
      sessionId: ctx.sessionId,
      availableTools: tools.map(tool => ({
        name: tool.function.name,
        summary: tool.function.description,
      })),
      deferredTools: [],
    })
    return [sharedPrompt, buildReviewerRolePrompt(ctx)].join('\n\n')
  },
}
