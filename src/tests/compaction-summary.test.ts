import { describe, expect, it } from 'vitest'
import {
  buildCompactionPrompt,
  normalizeCompactionSummary,
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
    expect(prompt).not.toContain('coveredThroughSequence')
    expect(prompt).toContain('ship context ledger')
  })

  it('requests tagged text and includes repair feedback', () => {
    const prompt = buildCompactionPrompt({
      coveredThroughSequence: 9,
      messages: [],
      validationFeedback: 'summary is empty'
    })
    expect(prompt).toContain('<analysis>')
    expect(prompt).toContain('<summary>')
    expect(prompt).toContain('summary is empty')
    expect(prompt).toContain('do not output JSON')
  })

  it('normalizes tagged or unstructured text while the host owns the boundary', () => {
    const tagged = normalizeCompactionSummary(
      '<analysis>draft</analysis><summary>Continue the migration.</summary>',
      12
    )
    const fallback = normalizeCompactionSummary('{"version":"1","goal":"continue"}', 13)

    expect(tagged).toEqual({
      version: 2,
      format: 'text',
      content: 'Continue the migration.',
      coveredThroughSequence: 12
    })
    expect(fallback).toMatchObject({
      version: 2,
      content: '{"version":"1","goal":"continue"}',
      coveredThroughSequence: 13
    })
  })
})
