import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubAgentContext, SubAgentDefinition } from '../main/agent/SubAgentManager'

const providerMock = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getApiKey: vi.fn(),
}))

vi.mock('../main/ipc/provider.handlers', () => ({
  getProviderService: () => providerMock,
}))

import { resolveSubAgentModelContext } from '../main/agent/SubAgentModelResolver'

const baseDefinition: SubAgentDefinition = {
  type: 'Executor',
  description: 'test',
  whenToUse: 'test',
  maxLoops: 1,
  getTools: () => [],
  systemPromptBuilder: () => 'test',
}

function makeContext(): SubAgentContext {
  return {
    workspaceRoot: '/workspace',
    sessionId: 'session-1',
    providerId: 'main-provider',
    task: 'test',
    parentPrompt: 'test',
    contextCapabilities: { contextWindowTokens: 200_000 },
    apiConfig: {
      baseUrl: 'https://main.example',
      apiKey: 'main-key',
      apiFormat: 'openai',
      model: 'main-model',
      thinking: { enabled: true, mode: 'auto' },
    },
  }
}

const fallbackProvider = {
  id: 'fallback-provider',
  name: 'Fallback',
  baseUrl: 'https://fallback.example',
  apiFormat: 'anthropic' as const,
  apiKeyRef: '',
  encryption: 'none' as const,
  enabled: true,
  createdAt: 'now',
  updatedAt: 'now',
  thinking: { enabled: true, mode: 'auto' as const },
  models: [{
    id: 'fast',
    name: 'fast-model',
    maxContextTokens: 100_000,
    maxInputTokens: 90_000,
    maxOutputTokens: 8_192,
    reasoningCountsAgainstContext: true,
    thinkingMode: 'anthropic' as const,
    thinkingBudgetTokens: 2_048,
  }],
}

describe('SubAgent model resolution', () => {
  beforeEach(() => {
    providerMock.getConfig.mockReset()
    providerMock.getApiKey.mockReset()
    providerMock.getConfig.mockImplementation((id: string) =>
      id === fallbackProvider.id ? fallbackProvider : null
    )
    providerMock.getApiKey.mockImplementation((id: string) =>
      id === fallbackProvider.id ? 'fallback-key' : null
    )
  })

  it('uses the first available manually configured candidate for any subagent type', () => {
    const resolved = resolveSubAgentModelContext(baseDefinition, makeContext(), [
      { providerId: 'removed-provider', model: 'removed-model' },
      { providerId: 'fallback-provider', model: 'fast-model' },
    ])

    expect(resolved).toMatchObject({
      providerId: 'fallback-provider',
      modelOverride: 'fast-model',
      contextCapabilities: {
        contextWindowTokens: 100_000,
        maxInputTokens: 90_000,
        maxOutputTokens: 8_192,
        reasoningCountsAgainstContext: true,
      },
      apiConfig: {
        baseUrl: 'https://fallback.example',
        apiKey: 'fallback-key',
        apiFormat: 'anthropic',
        model: 'fast-model',
        thinking: { enabled: true, mode: 'anthropic', budgetTokens: 2_048 },
      },
    })
  })

  it('fails visibly when every manually configured candidate is unavailable', () => {
    expect(() => resolveSubAgentModelContext(baseDefinition, makeContext(), [
      { providerId: 'removed-provider', model: 'removed-model' },
    ])).toThrow("Configured models for subagent 'Executor' are unavailable")
  })

  it('keeps the parent model when no manual candidates are configured', () => {
    const context = makeContext()
    expect(resolveSubAgentModelContext(baseDefinition, context, [])).toBe(context)
  })
})
