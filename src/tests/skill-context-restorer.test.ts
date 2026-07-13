import { describe, expect, it } from 'vitest'
import { SkillContextRestorer } from '../main/services/context/SkillContextRestorer'
import { ContextBudgetService } from '../main/services/context/ContextBudgetService'
import type { NormalizedModelMessage, PostCompactionSkillContext } from '../shared/types/context'

function invocation(name: string, content: string, sequence: number): NormalizedModelMessage[] {
  return [{
    id: `a-${sequence}`, turnId: `t-${sequence}`, role: 'assistant', content: '',
    toolCalls: [{ id: `skill-${sequence}`, name: 'Skill', arguments: JSON.stringify({ skill: name }) }],
    status: 'complete', createdAt: '2026-07-12T00:00:00.000Z', sourceSequence: sequence
  }, {
    id: `r-${sequence}`, turnId: `t-${sequence}`, role: 'tool', name: 'Skill',
    toolCallId: `skill-${sequence}`,
    content: JSON.stringify({ ok: true, data: content }),
    status: 'complete', createdAt: '2026-07-12T00:00:01.000Z', sourceSequence: sequence + 1
  }]
}

describe('SkillContextRestorer', () => {
  it('preserves invoked skill content with bounded post-compaction metadata', () => {
    const restorer = new SkillContextRestorer()
    const restored = restorer.restore({
      messages: invocation(
        'skill-name-as-id',
        `<command-name>Canonical Skill</command-name>\n${'S'.repeat(40_000)}`,
        1
      )
    })

    expect(restored?.skills[0].name).toBe('Canonical Skill')
    expect(restored?.skills[0].content).toContain('Skill content truncated after compaction')
    expect(restored?.content).toContain('invoked_skills')
    expect(new ContextBudgetService().estimateStringTokens(restored?.content || ''))
      .toBeLessThanOrEqual(25_000)
  })

  it('does not duplicate a skill whose complete result remains in the retained tail', () => {
    const messages = invocation('Review', 'review instructions', 1)
    expect(new SkillContextRestorer().restore({ messages, retainedTail: messages }))
      .toBeUndefined()
  })

  it('drops an older restored copy after the same skill is invoked again', () => {
    const context: PostCompactionSkillContext = {
      content: 'old', createdAt: '2026-07-12T00:00:00.000Z', sourceSequence: 10,
      skills: [{ name: 'Review', content: 'old instructions', invokedSequence: 2 }]
    }
    const reconciled = new SkillContextRestorer().reconcile({
      context,
      messages: invocation('Review', 'new instructions', 11)
    })
    expect(reconciled).toBeUndefined()
  })

  it('does not restore content for a session-disabled skill', () => {
    const messages = invocation('Review', '<command-name>Review</command-name>\nreview instructions', 1)
    expect(new SkillContextRestorer().restore({
      messages,
      activeSkillNames: new Set()
    })).toBeUndefined()
  })
})
