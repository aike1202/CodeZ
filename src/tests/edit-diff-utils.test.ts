import { describe, expect, it } from 'vitest'
import { buildDiffEditInfo, computeEditStats } from '../renderer/src/utils/editDiffUtils'

describe('batch Edit renderer metadata', () => {
  const args = JSON.stringify({
    file_path: 'src/example.ts',
    edits: [
      { old_string: 'alpha', new_string: 'ALPHA\nnext' },
      { old_string: 'beta\ngamma', new_string: '' }
    ]
  })

  it('aggregates additions and deletions across edits', () => {
    expect(computeEditStats('Edit', args)).toEqual({ additions: '+2', deletions: '-3' })
  })

  it('builds one multi-edit diff preview payload', () => {
    expect(buildDiffEditInfo('Edit', args)).toEqual({
      type: 'replace',
      targetContent: '--- Edit 1 ---\nalpha\n\n--- Edit 2 ---\nbeta\ngamma',
      replacementContent: '--- Edit 1 ---\nALPHA\nnext\n\n--- Edit 2 ---\n'
    })
  })
})
