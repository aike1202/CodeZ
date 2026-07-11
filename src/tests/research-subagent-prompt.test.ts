import { describe, expect, it } from 'vitest'
import { ResearchSubAgent } from '../main/agent/definitions/ResearchSubAgent'

describe('Research subagent handoff prompt', () => {
  it('requires a general Markdown handoff with shared tool policies', async () => {
    const prompt = await ResearchSubAgent.systemPromptBuilder({
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
      contextCapabilities: { contextWindowTokens: 100_000 },
    })

    expect(prompt).toContain('# Tool Policy')
    expect(prompt).toContain('Batch known reads before calling tools')
    expect(prompt).toContain('For an initial read without an evidence-based relevant range')
    expect(prompt).toContain('# Research Handoff')
    expect(prompt).toContain('## Direct Answer')
    expect(prompt).toContain('## Key Findings')
    expect(prompt).toContain('## Relevant Components')
    expect(prompt).toContain('## Priority References')
    expect(prompt).toContain('file_path:start_line-end_line')
    expect(prompt).toContain('Do NOT include source code excerpts')
  })
})
