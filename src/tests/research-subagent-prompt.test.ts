import { describe, expect, it } from 'vitest'
import { ResearchSubAgent } from '../main/agent/definitions/ResearchSubAgent'

describe('Research subagent handoff prompt', () => {
  it('requires a general Markdown handoff with evidence anchors', () => {
    const prompt = ResearchSubAgent.systemPromptBuilder({
      workspaceRoot: '/workspace',
      sessionId: 'session-1',
      task: 'Trace the execution path for a reported failure.',
      parentPrompt: 'Trace the execution path for a reported failure.',
      apiConfig: {
        baseUrl: 'https://example.invalid',
        apiKey: 'test-key',
        apiFormat: 'openai',
        model: 'test-model',
      },
    })

    expect(prompt).toContain('# Research Handoff')
    expect(prompt).toContain('## Direct Answer')
    expect(prompt).toContain('## Key Findings')
    expect(prompt).toContain('## Relevant Components')
    expect(prompt).toContain('## Priority References')
    expect(prompt).toContain('file_path:start_line-end_line')
    expect(prompt).toContain('Do NOT include source code excerpts')
  })
})
