import type { ResumeState, VersionedResumeState } from '../../../shared/types/context'

const SOURCE_PRIORITY: Record<VersionedResumeState['source'], number> = {
  framework: 0,
  compaction: 1,
  explicit_tool: 2
}

function stableUnique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))]
}

function preferredState(
  left: VersionedResumeState,
  right: VersionedResumeState
): [VersionedResumeState, VersionedResumeState] {
  if (right.coveredThroughSequence !== left.coveredThroughSequence) {
    return right.coveredThroughSequence > left.coveredThroughSequence ? [right, left] : [left, right]
  }
  return SOURCE_PRIORITY[right.source] > SOURCE_PRIORITY[left.source] ? [right, left] : [left, right]
}

export class ResumeStateManager {
  merge(
    current: VersionedResumeState | undefined,
    candidate: VersionedResumeState
  ): VersionedResumeState {
    if (!current) return structuredClone(candidate)
    const [preferred, fallback] = preferredState(current, candidate)
    const weakFramework = preferred.source === 'framework' && fallback.source !== 'framework'
    const choose = (key: keyof ResumeState): any => {
      const preferredValue = preferred.state[key]
      if (weakFramework && ['currentGoalId', 'currentPhase', 'currentStep', 'nextAction'].includes(key)) {
        return fallback.state[key] || preferredValue
      }
      return preferredValue || fallback.state[key]
    }

    const validationResults = [
      ...(preferred.state.validationResults || []),
      ...(fallback.state.validationResults || [])
    ].filter((value, index, all) =>
      all.findIndex((candidateValue) => candidateValue.commandOrCheck === value.commandOrCheck) === index
    )
    const completedChecks = new Set(validationResults.map((value) => value.commandOrCheck))
    const mergedState: ResumeState = {
      currentGoalId: choose('currentGoalId'),
      currentPhase: choose('currentPhase'),
      currentStep: choose('currentStep'),
      lastCompletedStep: choose('lastCompletedStep'),
      nextAction: choose('nextAction'),
      openQuestions: stableUnique([...preferred.state.openQuestions, ...fallback.state.openQuestions]),
      blockedBy: stableUnique([...preferred.state.blockedBy, ...fallback.state.blockedBy]),
      filesTouched: stableUnique([...preferred.state.filesTouched, ...fallback.state.filesTouched]),
      filesToInspectNext: stableUnique([...preferred.state.filesToInspectNext, ...fallback.state.filesToInspectNext]),
      validationPending: stableUnique([
        ...preferred.state.validationPending,
        ...fallback.state.validationPending
      ]).filter((value) => !completedChecks.has(value)),
      validationResults,
      goal: preferred.state.goal || fallback.state.goal,
      plan: preferred.state.plan || fallback.state.plan,
      contextFiles: stableUnique([
        ...(preferred.state.contextFiles || []),
        ...(fallback.state.contextFiles || [])
      ]),
      lastTrimmedAt: Math.max(preferred.state.lastTrimmedAt || 0, fallback.state.lastTrimmedAt || 0) || undefined,
      updatedAt: preferred.state.updatedAt || fallback.state.updatedAt
    }
    return {
      ...preferred,
      revision: Math.max(current.revision, candidate.revision),
      state: mergedState
    }
  }

  create(
    state: ResumeState,
    source: VersionedResumeState['source'],
    coveredThroughSequence: number,
    previousRevision = 0
  ): VersionedResumeState {
    return {
      revision: previousRevision + 1,
      coveredThroughSequence,
      source,
      updatedAt: new Date().toISOString(),
      state: structuredClone(state)
    }
  }

  renderBounded(value: VersionedResumeState, maxTokens = 800): string {
    const state = value.state
    const lines = [
      `<resume_state revision="${value.revision}" covered_through_sequence="${value.coveredThroughSequence}" source="${value.source}">`,
      `Goal: ${state.currentGoalId}`,
      `Phase: ${state.currentPhase}`,
      `Current step: ${state.currentStep}`,
      `Next action: ${state.nextAction}`,
      `Blocked by: ${state.blockedBy.join('; ') || 'none'}`,
      `Files touched: ${state.filesTouched.join('; ') || 'none'}`,
      `Files to inspect: ${state.filesToInspectNext.join('; ') || 'none'}`,
      `Context files: ${(state.contextFiles || []).join('; ') || 'none'}`,
      `Validation pending: ${state.validationPending.join('; ') || 'none'}`,
      '</resume_state>'
    ]
    const maxChars = Math.max(80, maxTokens * 4)
    const rendered = lines.join('\n')
    if (rendered.length <= maxChars) return rendered
    const closing = '\n</resume_state>'
    return `${rendered.slice(0, maxChars - closing.length)}${closing}`
  }
}
