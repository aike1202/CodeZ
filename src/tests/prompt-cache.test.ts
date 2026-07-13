import { describe, expect, it } from 'vitest'
import {
  buildAnthropicSystemBlocks,
  buildAnthropicTools
} from '../main/services/chat/AnthropicProvider'
import { buildGeminiContents } from '../main/services/chat/GeminiProvider'
import { resolveOpenAIMessages } from '../main/services/chat/OpenAIProvider'
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  splitSystemPromptSections
} from '../main/services/prompts/PromptCache'
import { PromptPipeline } from '../main/services/prompts/PromptPipeline'
import type { PromptContext } from '../main/services/prompts/PromptTypes'

const prompt = `stable behavior\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\ndynamic workspace`

describe('prompt caching', () => {
  it('splits stable and dynamic prompt sections into Anthropic cache blocks', () => {
    expect(splitSystemPromptSections(prompt)).toEqual({
      staticContent: 'stable behavior',
      dynamicContent: 'dynamic workspace'
    })
    expect(buildAnthropicSystemBlocks(prompt)).toEqual([
      { type: 'text', text: 'stable behavior', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'dynamic workspace', cache_control: { type: 'ephemeral' } }
    ])
  })

  it('places the tool-schema cache breakpoint on the final exposed tool', () => {
    const tools = buildAnthropicTools([
      { type: 'function', function: { name: 'Read', description: 'Read', parameters: {} } },
      { type: 'function', function: { name: 'Edit', description: 'Edit', parameters: {} } }
    ])!
    expect(tools[0]).not.toHaveProperty('cache_control')
    expect(tools[1].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('removes internal cache markers for OpenAI and Gemini payloads', async () => {
    const messages = [{ role: 'system' as const, content: prompt }]
    const openai = await resolveOpenAIMessages(messages)
    const gemini = await buildGeminiContents(messages)
    expect(openai[0].content).toBe('stable behavior\n\ndynamic workspace')
    expect(gemini.systemInstructionParts[0].text).toBe('stable behavior\n\ndynamic workspace')
  })

  it('awaits asynchronous module predicates in listEnabled', async () => {
    const context: PromptContext = {
      workspaceRoot: '/workspace',
      modelId: 'model',
      modelDisplayName: 'Model',
      contextWindowTokens: 100_000
    }
    const pipeline = new PromptPipeline()
      .register({ id: 'enabled', layer: 'core', priority: 0, isEnabled: async () => true, build: () => 'yes' })
      .register({ id: 'disabled', layer: 'core', priority: 1, isEnabled: async () => false, build: () => 'no' })

    await expect(pipeline.listEnabled(context)).resolves.toEqual([
      { id: 'enabled', layer: 'core', priority: 0 }
    ])
    await expect(pipeline.run(context)).resolves.toBe('yes')
  })
})
