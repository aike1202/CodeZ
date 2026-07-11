import { describe, expect, it } from 'vitest'
import {
  buildCompactionPrompt,
  parseAndValidateSummary,
  renderCompactionSummary
} from '../main/services/context/CompactionSummary'
import type { CompactionSummaryV1 } from '../shared/types/context'

function validSummary(coveredThroughSequence = 9): CompactionSummaryV1 {
  return {
    version: 1,
    goal: { currentObjective: 'ship context ledger', requirements: ['persist'], successCriteria: ['tests pass'] },
    status: { phase: 'implementation', completed: ['design'], inProgress: ['ledger'], nextActions: ['test'] },
    decisions: [{ decision: 'main owns history', rationale: 'ordering' }],
    facts: [], files: [], validation: [], errors: [], openQuestions: [],
    userInstructions: ['reply in Chinese'], coveredThroughSequence
  }
}

describe('CompactionSummary', () => {
  it('rejects malformed and wrongly-covered summaries', () => {
    expect(() => parseAndValidateSummary(JSON.stringify({ version: 1, coveredThroughSequence: 9 }), 9)).toThrow('COMPACTION_SCHEMA_INVALID')
    expect(() => parseAndValidateSummary(JSON.stringify(validSummary(8)), 9)).toThrow('coveredThroughSequence')
  })

  it('renders the same structured summary deterministically', () => {
    const summary = validSummary()
    const rendered = renderCompactionSummary(summary)
    expect(renderCompactionSummary(summary)).toBe(rendered)
    expect(rendered).toContain('Current objective: ship context ledger')
    expect(rendered).toContain('Covered through sequence: 9')
  })

  it('includes prior state and one-shot instructions in the generation prompt', () => {
    const prompt = buildCompactionPrompt({
      coveredThroughSequence: 9,
      messages: [],
      previousSummary: validSummary(4),
      instructions: 'keep migration decisions'
    })
    expect(prompt).toContain('keep migration decisions')
    expect(prompt).toContain('coveredThroughSequence')
    expect(prompt).toContain('ship context ledger')
  })

  it('includes a complete JSON shape and repair feedback', () => {
    const prompt = buildCompactionPrompt({
      coveredThroughSequence: 9,
      messages: [],
      validationFeedback: 'version must be 1',
      previousInvalidOutput: '{"version":"1"}'
    })
    expect(prompt).toContain('"version": 1')
    expect(prompt).toContain('"goal": {')
    expect(prompt).toContain('"currentObjective":')
    expect(prompt).toContain('"status": {')
    expect(prompt).toContain('version must be 1')
    expect(prompt).toContain('{"version":"1"}')
  })
})
