# Model Reasoning Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show only the reasoning controls supported by the selected model and send the matching provider-specific API parameters.

**Architecture:** Add one shared pure capability resolver that classifies the selected model, API format, base URL, and optional thinking-mode override. The renderer uses the resolver to choose effort, token-budget, toggle-only, or hidden controls; the main process uses the same result when building OpenAI, Anthropic, Gemini, DeepSeek, Qwen, Grok, and OpenRouter payloads.

**Tech Stack:** TypeScript, React 18, Zustand, Electron, Vitest

## Global Constraints

- Use only documented provider parameter names and documented effort values.
- Keep existing saved provider configurations backward compatible.
- Store prompt-level effort or budget overrides on the selected model, not globally across unrelated models.
- Preserve manual `thinkingMode` overrides.
- Do not modify unrelated dirty worktree files.
- Do not create a commit unless the user explicitly requests one.
- Official references: OpenAI reasoning/latest-model docs, Anthropic effort docs, Gemini thinking/OpenAI-compatibility docs, DeepSeek thinking-mode docs, Alibaba Cloud Qwen deep-thinking docs, and OpenRouter reasoning-token docs.

---

### Task 1: Define Shared Capability Metadata

**Files:**
- Create: `src/shared/utils/reasoningCapabilities.ts`
- Modify: `src/shared/types/provider.ts`
- Test: `src/tests/reasoning-capabilities.test.ts`

**Interfaces:**
- Consumes: `ApiFormat`, `ThinkingMode`, `ThinkingEffort`, model name, provider base URL.
- Produces: `getReasoningCapabilities(input)` and `resolveThinkingMode(input)` for renderer and main-process callers.

- [x] **Step 1: Write capability tests**

```ts
expect(getReasoningCapabilities({ model: 'gpt-5.6', apiFormat: 'openai', baseUrl: 'https://api.openai.com/v1' }).efforts)
  .toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
expect(getReasoningCapabilities({ model: 'claude-opus-4-8', apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com' }).efforts)
  .toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
expect(getReasoningCapabilities({ model: 'gemini-3.5-flash', apiFormat: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' }).efforts)
  .toEqual(['minimal', 'low', 'medium', 'high'])
expect(getReasoningCapabilities({ model: 'gemini-2.5-flash', apiFormat: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' }).control)
  .toBe('budget')
expect(getReasoningCapabilities({ model: 'deepseek-v4-pro', apiFormat: 'openai', baseUrl: 'https://api.deepseek.com' }).efforts)
  .toEqual(['high', 'max'])
expect(getReasoningCapabilities({ model: 'qwen3.7-plus', apiFormat: 'openai', baseUrl: 'https://dashscope.aliyuncs.com' }).control)
  .toBe('budget')
expect(getReasoningCapabilities({ model: 'gpt-4o', apiFormat: 'openai', baseUrl: 'https://api.openai.com/v1' }).control)
  .toBe('none')
```

- [x] **Step 2: Verify tests fail before implementation**

Run: `npm.cmd test -- src/tests/reasoning-capabilities.test.ts`

Expected: FAIL because the shared resolver does not exist.

- [x] **Step 3: Extend persisted model overrides**

```ts
export type ThinkingEffort = 'auto' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'custom'

export interface ModelConfig {
  thinkingEffort?: ThinkingEffort
  thinkingBudgetTokens?: number
}
```

- [x] **Step 4: Implement the pure resolver**

```ts
export interface ReasoningCapabilities {
  mode: ThinkingMode
  control: 'effort' | 'budget' | 'toggle' | 'none'
  efforts: ThinkingEffort[]
  budgetPresets?: number[]
  mandatory?: boolean
}
```

The resolver must use documented model-specific subsets, return `none` for known non-reasoning models, and honor explicit modes before auto-detection.

### Task 2: Build Provider-Specific Payloads

**Files:**
- Modify: `src/main/services/chat/utils.ts`
- Modify: `src/main/services/chat/OpenAIProvider.ts`
- Modify: `src/main/services/chat/AnthropicProvider.ts`
- Modify: `src/main/services/chat/GeminiProvider.ts`
- Modify: `src/main/ipc/chat.handlers.ts`
- Test: `src/tests/chat-service.test.ts`

**Interfaces:**
- Consumes: `getReasoningCapabilities`, provider API format, model-level effort/budget overrides.
- Produces: Only the documented request keys for the resolved provider and selected model.

- [x] **Step 1: Add failing payload expectations**

```ts
expect(buildThinkingPayload({ enabled: true, mode: 'openai', effort: 'max' }, 'gpt-5.6', openAIUrl, false, 'openai'))
  .toEqual({ reasoning_effort: 'max' })
expect(buildThinkingPayload({ enabled: true, mode: 'deepseek', effort: 'max' }, 'deepseek-v4-pro', deepSeekUrl, false, 'openai'))
  .toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'max' })
expect(buildThinkingPayload({ enabled: true, mode: 'qwen', budgetTokens: 4096 }, 'qwen3.7-plus', dashScopeUrl, false, 'openai'))
  .toEqual({ enable_thinking: true, thinking_budget: 4096 })
expect(buildThinkingPayload({ enabled: true, mode: 'gemini', effort: 'low' }, 'gemini-3.5-flash', geminiUrl, false, 'gemini'))
  .toEqual({ google: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'low' } } })
```

- [x] **Step 2: Pass API format from each provider**

```ts
buildThinkingPayload(thinking, model, baseUrl, hasTools, 'openai')
buildThinkingPayload(thinking, model, baseUrl, hasTools, 'anthropic')
buildThinkingPayload(thinking, model, baseUrl, hasTools, 'gemini')
```

- [x] **Step 3: Merge selected-model overrides**

```ts
thinking: {
  ...config.thinking,
  ...(modelConfig?.thinkingMode ? { mode: modelConfig.thinkingMode } : {}),
  ...(modelConfig?.thinkingEffort ? { effort: modelConfig.thinkingEffort } : {}),
  ...(modelConfig?.thinkingBudgetTokens !== undefined ? { budgetTokens: modelConfig.thinkingBudgetTokens } : {})
}
```

- [x] **Step 4: Implement documented request shapes**

OpenAI/Grok/Gemini-compatible requests use `reasoning_effort`; Anthropic uses `output_config.effort`; Gemini Native uses camel-case `generationConfig.thinkingConfig`; DeepSeek uses `thinking.type` plus `reasoning_effort`; Qwen uses `enable_thinking` plus `thinking_budget`; OpenRouter uses `reasoning.effort`.

### Task 3: Render Selected-Model Controls

**Files:**
- Modify: `src/renderer/src/components/PromptArea/index.tsx`
- Modify: `src/renderer/src/components/SettingsPanel.tsx`
- Modify: `src/renderer/src/stores/providerStore.ts`
- Modify: `src/main/ipc/provider.handlers.ts`
- Test: `src/tests/reasoning-capabilities.test.ts`

**Interfaces:**
- Consumes: Selected model, shared capabilities, `updateProvider`.
- Produces: A model-specific effort select, token-budget select, or no strength control.

- [x] **Step 1: Add labels for exact API values**

```ts
const EFFORT_LABELS = {
  none: '关闭',
  minimal: '极低',
  low: '轻度',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高'
}
```

- [x] **Step 2: Derive controls during render**

Resolve capabilities directly from `selectedModelName`, active provider API format/base URL, and the selected model's optional `thinkingMode`; do not mirror derived capability state in an effect.

- [x] **Step 3: Persist changes on the selected model**

```ts
updateProvider(activeProvider.id, {
  models: activeProvider.models.map(model =>
    model.name === selectedModelName ? { ...model, thinkingEffort: nextEffort } : model
  )
})
```

- [x] **Step 4: Limit settings token input**

Show the provider default token-budget input only when at least one configured model resolves to budget control. Keep the existing global enable toggle for backward compatibility.

- [x] **Step 5: Preserve API format in provider state**

Return and type `apiFormat` for provider create/update operations so newly created Anthropic/Gemini providers immediately render correct controls.

### Task 4: Verify Integration

**Files:**
- Test: `src/tests/reasoning-capabilities.test.ts`
- Test: `src/tests/chat-service.test.ts`

**Interfaces:**
- Consumes: All previous tasks.
- Produces: Passing focused tests, related tests, and type checking.

- [x] **Step 1: Run focused tests**

Run: `npm.cmd test -- src/tests/reasoning-capabilities.test.ts src/tests/chat-service.test.ts`

Expected: PASS.

- [x] **Step 2: Run provider-related tests**

Run: `npm.cmd test -- src/tests/push-provider.test.ts src/tests/anthropic-provider-compatibility.test.ts`

Expected: PASS for files that exist; omit a filename only if the repository has no such test.

- [x] **Step 3: Type-check**

Run: `npm.cmd run typecheck`

Expected: PASS with no TypeScript errors.

## Self-Review

- Spec coverage: The plan covers per-model visibility, exact effort subsets, numeric budgets, and provider-specific payloads.
- Placeholder scan: No deferred implementation placeholders remain.
- Type consistency: `ThinkingEffort`, model overrides, capability results, renderer values, and request payloads use the same exact strings.
