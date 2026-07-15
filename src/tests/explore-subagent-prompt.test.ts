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
    expect(ExploreSubAgent.whenNotToUse).toContain('use Reviewer instead')
    expect(ExploreSubAgent.outputSpec?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'report', required: true }),
      expect.objectContaining({ name: 'conclusion', required: true }),
      expect.objectContaining({ name: 'confidence', required: true }),
    ]))
  })

  it('uses read tools and shell inspection without exposing write tools', () => {
    const names = ExploreSubAgent.getTools(new ToolManager()).map((tool) => tool.function.name)

    expect(names).toEqual(expect.arrayContaining(['Read', 'list_files', 'Glob', 'Grep']))
    expect(names).toEqual(expect.arrayContaining(['Bash', 'PowerShell']))
    expect(names).not.toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit']))
  })

  it('uses the shared tool policy and requires a Markdown submit_result handoff', async () => {
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

    expect(prompt).toContain('# Using tools')
    expect(prompt).toContain('file search specialist')
    expect(prompt).toContain('Critical: Read-only mode')
    expect(prompt).toContain('Batch independent searches and reads')
    expect(prompt).toContain('Submit a concise Markdown report through submit_result')
    expect(prompt).toContain('do not return the final answer as plain text')
  })
})
