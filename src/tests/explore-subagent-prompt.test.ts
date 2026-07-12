import { describe, expect, it } from 'vitest'
import { ExploreSubAgent } from '../main/agent/definitions/ExploreSubAgent'
import { ToolManager } from '../main/tools/ToolManager'

describe('Explore subagent prompt', () => {
  it('advertises fast read-only codebase exploration', () => {
    expect(ExploreSubAgent.type).toBe('Explore')
    expect(ExploreSubAgent.description).toContain('Fast read-only agent')
    expect(ExploreSubAgent.whenToUse).toContain('directed search is insufficient')
    expect(ExploreSubAgent.whenToUse).toContain('more than a few dependent queries')
    expect(ExploreSubAgent.whenNotToUse).toContain('Glob, Grep, or Read')
    expect(ExploreSubAgent.outputSpec).toBeUndefined()
  })

  it('uses read tools and shell inspection without exposing write tools', () => {
    const names = ExploreSubAgent.getTools(new ToolManager()).map((tool) => tool.function.name)

    expect(names).toEqual(expect.arrayContaining(['Read', 'list_files', 'Glob', 'Grep']))
    expect(names).toEqual(expect.arrayContaining(['Bash', 'PowerShell']))
    expect(names).not.toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit']))
  })

  it('uses the shared tool policy and requests a concise plain-text report', async () => {
    const prompt = await ExploreSubAgent.systemPromptBuilder({
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
    expect(prompt).toContain('file search specialist')
    expect(prompt).toContain('Critical: Read-only mode')
    expect(prompt).toContain('Batch independent searches and reads')
    expect(prompt).toContain('Return a concise report directly as normal text')
    expect(prompt).toContain('do not call submit_result')
    expect(prompt).not.toContain('# Research Handoff')
  })
})
