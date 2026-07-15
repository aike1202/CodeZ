import { describe, expect, it } from 'vitest'
import { SubAgentManager } from '../main/agent/SubAgentManager'

describe('built-in SubAgent final response protocol', () => {
  it('requires every built-in SubAgent to submit a Markdown report', () => {
    for (const type of ['Explore', 'Reviewer', 'ExecutionPlanner', 'Executor']) {
      const definition = SubAgentManager.getDefinition(type)
      expect(definition?.outputSpec, `${type} outputSpec`).toBeDefined()

      const fields = new Map(
        definition!.outputSpec!.fields.map((field) => [field.name, field])
      )
      expect(fields.get('report'), `${type} report`).toMatchObject({
        type: 'string',
        required: true,
      })
      expect(fields.get('conclusion'), `${type} conclusion`).toMatchObject({
        type: 'string',
        required: true,
      })
      expect(fields.get('confidence'), `${type} confidence`).toMatchObject({
        type: 'string',
        required: true,
      })
    }
  })
})
