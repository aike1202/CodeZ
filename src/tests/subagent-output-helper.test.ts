import { describe, expect, it } from 'vitest'
import {
  formatSubmitResultValidationMessage,
  validateAgainstSpec,
} from '../main/agent/AgentRunner/subagentOutputHelper'
import type { SubAgentOutputSpec } from '../main/agent/SubAgentManager'

const workerSpec: SubAgentOutputSpec = {
  description: 'Report worker status.',
  fields: [
    { name: 'status', type: 'string', description: 'completed or failed', required: true },
    { name: 'summary', type: 'string', description: 'what changed', required: true },
    { name: 'filesModified', type: 'string[]', description: 'modified files', required: true },
    { name: 'blockers', type: 'string[]', description: 'failure blockers', required: false },
  ],
}

describe('validateAgainstSpec', () => {
  it('accepts Worker submit_result fields instead of requiring research fields', () => {
    const result = validateAgainstSpec(
      {
        status: 'completed',
        summary: 'Updated the toolchain.',
        filesModified: ['src/a.ts'],
      },
      workerSpec
    )

    expect(result).toMatchObject({
      status: 'completed',
      summary: 'Updated the toolchain.',
      filesModified: ['src/a.ts'],
      confidence: 'medium',
    })
  })

  it('rejects data missing required spec fields', () => {
    expect(validateAgainstSpec({ status: 'completed', summary: 'Done' }, workerSpec)).toBeUndefined()
  })
})

describe('formatSubmitResultValidationMessage', () => {
  it('describes the active spec fields', () => {
    expect(formatSubmitResultValidationMessage(workerSpec)).toBe(
      'submit_result data did not match the expected schema. Required fields: "status" (string), "summary" (string), "filesModified" (string[]). Optional fields: "blockers" (string[]). Then call submit_result again.'
    )
  })
})
