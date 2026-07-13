import type {
  SubAgentContext,
  SubAgentDefinition,
  SubAgentStructuredOutput,
} from '../SubAgentManager'
import type { ToolManager } from '../../tools/ToolManager'
import { buildSharedToolUsePrompt } from '../../services/prompts/SubAgentPrompts'
import type { ToolDefinition } from '../../../shared/types/provider'

function getReviewerTools(toolManager: ToolManager): ToolDefinition[] {
  const tools = toolManager.getReadOnlyTools()
  for (const name of ['Bash', 'PowerShell']) {
    const tool = toolManager.getTool(name)
    if (!tool) continue
    tools.push({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters_schema,
      },
    })
  }
  return tools
}

function validateReviewerOutput(output: SubAgentStructuredOutput): string | undefined {
  const result = output as unknown as Record<string, unknown>
  const verdict = String(result.verdict)
  if (!['PASS', 'FAIL', 'PARTIAL'].includes(verdict)) {
    return 'verdict must be exactly "PASS", "FAIL", or "PARTIAL".'
  }
  if (!Array.isArray(result.checksRun) || result.checksRun.length === 0) {
    return 'checksRun must include at least one executed check or an explicit BLOCKED entry.'
  }
  if (!Array.isArray(result.filesExamined) || result.filesExamined.length === 0) {
    return 'filesExamined must identify the project evidence inspected during review.'
  }
  if (!Number.isInteger(result.unresolvedCount) || Number(result.unresolvedCount) < 0) {
    return 'unresolvedCount must be a non-negative integer.'
  }
  const findings = Array.isArray(result.findings) ? result.findings : []
  if (verdict === 'PASS' && Number(result.unresolvedCount) !== 0) {
    return 'PASS requires unresolvedCount to be zero.'
  }
  if (verdict === 'PASS' && findings.length > 0) {
    return 'PASS cannot include actionable findings; use FAIL or remove non-actionable observations from findings.'
  }
  if (verdict === 'FAIL' && findings.length === 0) {
    return 'FAIL must include at least one actionable finding.'
  }
  if (verdict === 'PARTIAL' && Number(result.unresolvedCount) === 0) {
    return 'PARTIAL must identify at least one unresolved review question.'
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

  return [
    'You are an independent implementation reviewer for CodeZ. Your job is to find defects, omissions, regressions, and unsupported completion claims before the parent Agent reports success.',
    '',
    '## Critical: Review only',
    '- Do not create, edit, delete, move, or copy project files.',
    '- Do not install dependencies or run Git write operations such as add, commit, checkout, merge, or push.',
    '- Do not delegate to another subagent.',
    '- You may run focused tests, type checks, builds, linters, and read-only diagnostic commands. Ordinary caches or build artifacts created by those commands are acceptable, but do not intentionally alter source files.',
    '- Never fix a defect yourself. Report it so the parent Agent can fix it and launch a new review with your findings.',
    '',
    '## Required caller brief',
    'The task must provide all applicable sections below:',
    '1. Original user goal and acceptance criteria.',
    '2. Actual changes and implementation approach.',
    '3. Complete list of files changed for this request, distinguishing unrelated pre-existing changes.',
    '4. Verification commands already run and their actual results.',
    '5. Known risks, unresolved items, and any relevant plan or specification path.',
    'If critical information is missing and cannot be established from repository evidence, return PARTIAL and name exactly what is missing.',
    '',
    '## Review workflow',
    '1. Restate the success criteria from the original goal. Do not replace them with the implementer\'s summary.',
    '2. Inspect the supplied files and relevant diff. Trace affected callers, contracts, error paths, and tests.',
    '3. Check that the implementation covers the entire requested behavior, not merely the polished happy path.',
    '4. Independently run the smallest meaningful checks. Do not treat the implementer\'s reported test results as evidence.',
    '5. Run at least one relevant adversarial probe when behavior changed, such as a boundary, malformed input, idempotency, concurrency, persistence, or failure-path check.',
    '6. Report actionable findings first, ordered by severity: P0 critical, P1 high, P2 medium, P3 low. Include file and line references when available.',
    '7. Use PASS only when there are no actionable correctness findings and the evidence supports the original goal. Use FAIL for actionable defects. Use PARTIAL only for concrete environment, tool, or missing-context limitations.',
    '',
    '## Submission contract',
    'Call submit_result exactly once the review is complete. Provide:',
    '- verdict: PASS, FAIL, or PARTIAL.',
    '- report: findings-first review with expected versus actual behavior and evidence.',
    '- conclusion: one concise sentence the parent can use to decide the next action.',
    '- confidence: high, medium, or low.',
    '- findings: actionable findings with severity and source location; use an empty array when there are no actionable findings, including limitation-only PARTIAL reviews.',
    '- checksRun: exact commands/checks and observed outcomes; use a BLOCKED entry when a check could not run.',
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
  allowShell: true,
  shellPolicy: 'verification',

  whenToUse: [
    'After implementation changes are complete and primary checks have run, before reporting completion to the user.',
    'To independently audit changed code, configuration, resources, tests, or implementation of a plan/specification.',
    'Run Reviewer again after fixing a FAIL, passing the original brief, previous findings, and the new corrections.',
  ].join('\n'),
  whenNotToUse: [
    'General codebase exploration, research, or implementation work.',
    'Before the parent Agent has completed the change and gathered the actual changed-file list.',
    'As a substitute for the parent Agent running proportionate primary verification.',
    'Pure question answering or read-only investigation where no project files changed.',
  ].join('\n'),
  costHint:
    'Up to 24 review tool calls. Uses configured candidate models and otherwise follows the main Agent model.',

  getTools: getReviewerTools,

  outputSpec: {
    description: 'Submit the independent review verdict, findings, and verification evidence.',
    fields: [
      {
        name: 'verdict',
        type: 'string',
        description: 'Exactly "PASS", "FAIL", or "PARTIAL".',
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
        name: 'findings',
        type: 'string[]',
        description: 'Actionable findings ordered by severity with file and line references when available.',
        required: true,
      },
      {
        name: 'checksRun',
        type: 'string[]',
        description: 'Exact commands or direct checks and their observed outcomes; include BLOCKED reasons.',
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
    const tools = ctx.promptTools || ['Read', 'list_files', 'Glob', 'Grep', 'Bash', 'PowerShell'].map(name => ({
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
