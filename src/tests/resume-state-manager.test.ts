import { describe, expect, it } from 'vitest'
import { ResumeStateManager } from '../main/services/context/ResumeStateManager'
import type { ResumeState, VersionedResumeState } from '../shared/types/context'

function state(value: Partial<ResumeState> = {}): ResumeState {
  return {
    currentGoalId: 'goal', currentPhase: 'implementation', currentStep: 'code',
    nextAction: 'test', openQuestions: [], blockedBy: [], filesTouched: [],
    filesToInspectNext: [], validationPending: [], ...value
  }
}

function versioned(
  source: VersionedResumeState['source'],
  coveredThroughSequence: number,
  value: Partial<ResumeState>
): VersionedResumeState {
  return { revision: coveredThroughSequence, coveredThroughSequence, source, updatedAt: '2026-07-10T00:00:00.000Z', state: state(value) }
}

describe('ResumeStateManager', () => {
  it('prefers explicit evidence when coverage is equal', () => {
    const manager = new ResumeStateManager()
    const framework = versioned('framework', 10, { currentPhase: 'auto-save', nextAction: 'old' })
    const explicit = versioned('explicit_tool', 10, { currentPhase: 'implementation', nextAction: 'test' })
    expect(manager.merge(framework, explicit).source).toBe('explicit_tool')
  })

  it('does not let an empty framework snapshot erase stronger fields', () => {
    const manager = new ResumeStateManager()
    const explicit = versioned('explicit_tool', 10, { currentPhase: 'implementation', nextAction: 'test' })
    const framework = versioned('framework', 11, { currentPhase: '', nextAction: '' })
    expect(manager.merge(explicit, framework).state).toMatchObject({ currentPhase: 'implementation', nextAction: 'test' })
  })

  it('does not re-add pending validation after a result exists', () => {
    const merged = new ResumeStateManager().merge(
      versioned('explicit_tool', 5, {
        validationResults: [{ commandOrCheck: 'npm test', status: 'passed', result: 'PASS' }]
      }),
      versioned('compaction', 6, { validationPending: ['npm test'] })
    )
    expect(merged.state.validationResults).toContainEqual({ commandOrCheck: 'npm test', status: 'passed', result: 'PASS' })
    expect(merged.state.validationPending).not.toContain('npm test')
  })

  it('renders a bounded deterministic resume block', () => {
    const manager = new ResumeStateManager()
    const rendered = manager.renderBounded(versioned('explicit_tool', 8, {
      filesTouched: Array.from({ length: 100 }, (_, index) => `src/file-${index}.ts`)
    }), 120)
    expect(rendered).toContain('<resume_state')
    expect(rendered.length).toBeLessThanOrEqual(480)
  })
})
