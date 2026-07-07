# Anthropic Provider Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Anthropic provider compatible with current Claude models by using adaptive thinking where required, streaming thinking deltas, normalizing newer stop reasons, and locking behavior with tests.

**Architecture:** Keep the existing custom provider architecture (`fetch` + SSE parser) and make focused compatibility updates. `buildThinkingPayload()` remains the provider-specific request-shaping function; `AnthropicProvider` gains small exported helpers for stop-reason and delta parsing so the behavior is directly unit-testable without mocking a streaming HTTP response.

**Tech Stack:** Electron, TypeScript, React, Vitest, custom Provider abstraction, Anthropic Messages API over streaming SSE.

## Global Constraints

- Scope is limited to `src/main/services/chat/utils.ts`, `src/main/services/chat/AnthropicProvider.ts`, and `src/tests/chat-service.test.ts`.
- Do not migrate Anthropic calls to `@anthropic-ai/sdk`.
- Do not change Provider settings UI.
- Do not add `xhigh` or `max` effort options in this pass.
- Do not implement compaction, Files API, Managed Agents, or server-side tool fallback.
- Do not change OpenAI or Gemini provider behavior.
- For adaptive-only Claude models, do not send `budget_tokens`.
- For older Claude models, preserve the existing `budget_tokens` behavior.
- Run `npm test` and `npm run typecheck` after implementation.

---

## File Structure

- Modify `src/main/services/chat/utils.ts`
  - Owns provider-specific thinking payload construction.
  - Add adaptive-only Claude model classification.
  - Keep OpenAI, DeepSeek, Qwen, Gemini, and OpenRouter branches unchanged.

- Modify `src/main/services/chat/AnthropicProvider.ts`
  - Owns Anthropic request conversion, streaming SSE parsing, and callback emission.
  - Add exported parser helpers:
    - `mapAnthropicStopReason(stopReason: string): AgentStopReason`
    - `extractAnthropicDelta(delta: any): { textDelta: string; reasoningDelta: string; toolInputDelta: string }`
  - Use helpers inside the existing stream loop.

- Modify `src/tests/chat-service.test.ts`
  - Owns focused chat/provider utility tests.
  - Add tests for adaptive-only Anthropic thinking payloads.
  - Add tests for Anthropic stop-reason and delta helpers.
  - Keep existing OpenAI/Gemini/DeepSeek/Qwen assertions passing.

---

### Task 1: Add failing tests for Anthropic thinking payload compatibility

**Files:**
- Modify: `src/tests/chat-service.test.ts:1-177`
- Test: `src/tests/chat-service.test.ts`

**Interfaces:**
- Consumes: existing `buildThinkingPayload(thinking, model, baseUrl, hasTools?)` from `src/main/services/chat/utils.ts`.
- Produces: regression expectations that Task 2 must satisfy.

- [ ] **Step 1: Add adaptive-only Claude model tests**

In `src/tests/chat-service.test.ts`, inside `describe('ChatService - buildThinkingPayload (自动适配与推导)', () => { ... })`, add these tests after the OpenRouter test and before the DeepSeek auto-mode test:

```ts
  it('应当对 Claude Opus 4.8 使用 adaptive thinking 且不发送 budget_tokens', () => {
    const payload = buildThinkingPayload(
      { enabled: true, mode: 'anthropic', effort: 'high' },
      'claude-opus-4-8',
      'https://api.anthropic.com/v1'
    )

    expect(payload).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' }
    })
    expect(JSON.stringify(payload)).not.toContain('budget_tokens')
  })

  it('应当对 Claude Sonnet 5 使用 adaptive thinking 且不发送 custom budget_tokens', () => {
    const payload = buildThinkingPayload(
      { enabled: true, mode: 'anthropic', effort: 'custom', budgetTokens: 2000 },
      'claude-sonnet-5',
      'https://api.anthropic.com/v1'
    )

    expect(payload).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' }
    })
    expect(JSON.stringify(payload)).not.toContain('budget_tokens')
  })

  it('应当在 auto mode 下对 Claude Fable 5 推导为 adaptive thinking', () => {
    const payload = buildThinkingPayload(
      { enabled: true, mode: 'auto', effort: 'medium' },
      'claude-fable-5',
      'https://api.anthropic.com/v1'
    )

    expect(payload).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' }
    })
    expect(JSON.stringify(payload)).not.toContain('budget_tokens')
  })
```

- [ ] **Step 2: Run the targeted test and verify it fails**

Run:

```bash
npm test -- src/tests/chat-service.test.ts
```

Expected: FAIL. At least the first new test should show that current output is not adaptive and may include old thinking configuration.

- [ ] **Step 3: Do not change production code in this task**

Leave `src/main/services/chat/utils.ts` unchanged. This task is complete once the failing tests document the desired behavior.

- [ ] **Step 4: Commit this test-only task if the workflow allows commits**

Only commit if the user explicitly requested commits for this implementation session. Otherwise skip the commit step and continue.

```bash
git add src/tests/chat-service.test.ts
git commit -m "test: cover adaptive Claude thinking payloads"
```

---

### Task 2: Implement adaptive thinking payload for current Claude models

**Files:**
- Modify: `src/main/services/chat/utils.ts:1-106`
- Test: `src/tests/chat-service.test.ts`

**Interfaces:**
- Consumes: tests from Task 1.
- Produces: `buildThinkingPayload()` behavior where adaptive-only Claude models return `thinking: { type: 'adaptive', display: 'summarized' }` and never include `budget_tokens`.

- [ ] **Step 1: Add adaptive-only model helpers**

In `src/main/services/chat/utils.ts`, add these helpers after `resolveBudgetTokens()` and before `export function buildThinkingPayload(...)`:

```ts
function isAdaptiveOnlyAnthropicModel(model: string): boolean {
  const modelLower = model.toLowerCase()
  return modelLower.includes('claude-opus-4-8')
    || modelLower.includes('claude-opus-4-7')
    || modelLower.includes('claude-sonnet-5')
    || modelLower.includes('claude-fable-5')
    || modelLower.includes('claude-mythos-5')
}

function buildAnthropicEffortPayload(thinking: ThinkingConfig): Record<string, unknown> {
  if (thinking.effort && ['low', 'medium', 'high'].includes(thinking.effort)) {
    return { output_config: { effort: thinking.effort } }
  }
  return {}
}
```

- [ ] **Step 2: Replace the Anthropic branch**

In `src/main/services/chat/utils.ts`, replace the current `case 'anthropic':` block:

```ts
    case 'anthropic':
      const anthropicPayload: Record<string, unknown> = {}
      if (resolvedTokens) {
        anthropicPayload.thinking = { type: 'enabled', budget_tokens: Math.max(1024, resolvedTokens) }
      }
      if (thinking.effort && ['low', 'medium', 'high'].includes(thinking.effort)) {
        anthropicPayload.output_config = { effort: thinking.effort }
      }
      return anthropicPayload
```

with:

```ts
    case 'anthropic': {
      const anthropicPayload: Record<string, unknown> = {}
      if (isAdaptiveOnlyAnthropicModel(model)) {
        anthropicPayload.thinking = { type: 'adaptive', display: 'summarized' }
        return {
          ...anthropicPayload,
          ...buildAnthropicEffortPayload(thinking),
        }
      }
      if (resolvedTokens) {
        anthropicPayload.thinking = { type: 'enabled', budget_tokens: Math.max(1024, resolvedTokens) }
      }
      return {
        ...anthropicPayload,
        ...buildAnthropicEffortPayload(thinking),
      }
    }
```

- [ ] **Step 3: Run targeted tests**

Run:

```bash
npm test -- src/tests/chat-service.test.ts
```

Expected: PASS for the new adaptive thinking tests and the existing old-model budget-token test:

```ts
expect(payloadAnthropic).toEqual({ thinking: { type: 'enabled', budget_tokens: 2000 } })
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS. If TypeScript reports a formatting or block-scope issue around the `case` block, keep the braced `case 'anthropic': { ... }` shape and fix only the local syntax.

- [ ] **Step 5: Commit this task if the workflow allows commits**

Only commit if the user explicitly requested commits for this implementation session. Otherwise skip the commit step and continue.

```bash
git add src/main/services/chat/utils.ts src/tests/chat-service.test.ts
git commit -m "fix: use adaptive thinking for current Claude models"
```

---

### Task 3: Add failing tests for Anthropic SSE helper behavior

**Files:**
- Modify: `src/tests/chat-service.test.ts:1-177`
- Test: `src/tests/chat-service.test.ts`

**Interfaces:**
- Consumes: planned exports from Task 4:
  - `mapAnthropicStopReason(stopReason: string): AgentStopReason`
  - `extractAnthropicDelta(delta: any): { textDelta: string; reasoningDelta: string; toolInputDelta: string }`
- Produces: failing tests that define how Anthropic stream deltas and stop reasons must be parsed.

- [ ] **Step 1: Add imports for planned helpers**

At the top of `src/tests/chat-service.test.ts`, after the existing imports, add:

```ts
import { mapAnthropicStopReason, extractAnthropicDelta } from '../main/services/chat/AnthropicProvider'
```

- [ ] **Step 2: Add stop-reason and delta tests**

At the end of `src/tests/chat-service.test.ts`, after the `buildThinkingPayload` describe block, add:

```ts
describe('AnthropicProvider - stream helpers', () => {
  it('应当映射 Anthropic stop_reason 到内部 stop reason', () => {
    expect(mapAnthropicStopReason('end_turn')).toBe('stop')
    expect(mapAnthropicStopReason('stop_sequence')).toBe('stop')
    expect(mapAnthropicStopReason('max_tokens')).toBe('length')
    expect(mapAnthropicStopReason('tool_use')).toBe('tool_calls')
    expect(mapAnthropicStopReason('refusal')).toBe('content_filter')
    expect(mapAnthropicStopReason('safety')).toBe('content_filter')
    expect(mapAnthropicStopReason('pause_turn')).toBe('tool_calls')
    expect(mapAnthropicStopReason('unknown_reason')).toBe('unknown')
  })

  it('应当从 Anthropic text_delta 中提取正文增量', () => {
    expect(extractAnthropicDelta({ type: 'text_delta', text: 'hello' })).toEqual({
      textDelta: 'hello',
      reasoningDelta: '',
      toolInputDelta: ''
    })
  })

  it('应当从 Anthropic thinking_delta 中提取 reasoning 增量', () => {
    expect(extractAnthropicDelta({ type: 'thinking_delta', thinking: 'reasoning' })).toEqual({
      textDelta: '',
      reasoningDelta: 'reasoning',
      toolInputDelta: ''
    })
  })

  it('应当兼容 tool_use_input_delta 与 input_json_delta 的 partial_json', () => {
    expect(extractAnthropicDelta({ type: 'tool_use_input_delta', partial_json: '{"a"' })).toEqual({
      textDelta: '',
      reasoningDelta: '',
      toolInputDelta: '{"a"'
    })

    expect(extractAnthropicDelta({ type: 'input_json_delta', partial_json: ':1}' })).toEqual({
      textDelta: '',
      reasoningDelta: '',
      toolInputDelta: ':1}'
    })
  })
})
```

- [ ] **Step 3: Run the targeted test and verify it fails**

Run:

```bash
npm test -- src/tests/chat-service.test.ts
```

Expected: FAIL because `mapAnthropicStopReason` and `extractAnthropicDelta` are not exported yet.

- [ ] **Step 4: Do not change production code in this task**

This task is complete once the failing tests define the desired parser helper behavior.

- [ ] **Step 5: Commit this test-only task if the workflow allows commits**

Only commit if the user explicitly requested commits for this implementation session. Otherwise skip the commit step and continue.

```bash
git add src/tests/chat-service.test.ts
git commit -m "test: cover Anthropic stream helper behavior"
```

---

### Task 4: Implement Anthropic SSE helpers and wire them into the parser

**Files:**
- Modify: `src/main/services/chat/AnthropicProvider.ts:1-199`
- Test: `src/tests/chat-service.test.ts`

**Interfaces:**
- Consumes: failing tests from Task 3.
- Produces:
  - `mapAnthropicStopReason(stopReason: string): AgentStopReason`
  - `extractAnthropicDelta(delta: any): { textDelta: string; reasoningDelta: string; toolInputDelta: string }`
  - Anthropic stream loop emits thinking deltas to `callbacks.onChunk('', reasoningDelta)`.

- [ ] **Step 1: Add shared type import**

At the top of `src/main/services/chat/AnthropicProvider.ts`, replace the current imports:

```ts
import { IChatProvider, ChatRequestConfig, StreamCallbacks } from './types'
import log from '../../logger'
import { logPrompt } from '../PromptLogger'
```

with:

```ts
import { IChatProvider, ChatRequestConfig, StreamCallbacks } from './types'
import type { AgentStopReason } from '../../../shared/types/provider'
import log from '../../logger'
import { logPrompt } from '../PromptLogger'
```

- [ ] **Step 2: Add exported helper functions**

In `src/main/services/chat/AnthropicProvider.ts`, add this code after the imports and before `export class AnthropicProvider implements IChatProvider {`:

```ts
export interface AnthropicDeltaParts {
  textDelta: string
  reasoningDelta: string
  toolInputDelta: string
}

export function mapAnthropicStopReason(stopReason: string): AgentStopReason {
  if (stopReason === 'end_turn' || stopReason === 'stop_sequence') {
    return 'stop'
  }
  if (stopReason === 'max_tokens') {
    return 'length'
  }
  if (stopReason === 'tool_use' || stopReason === 'pause_turn') {
    return 'tool_calls'
  }
  if (stopReason === 'refusal' || stopReason === 'safety') {
    return 'content_filter'
  }
  return 'unknown'
}

export function extractAnthropicDelta(delta: any): AnthropicDeltaParts {
  if (delta?.type === 'text_delta') {
    return {
      textDelta: delta.text || '',
      reasoningDelta: '',
      toolInputDelta: '',
    }
  }
  if (delta?.type === 'thinking_delta') {
    return {
      textDelta: '',
      reasoningDelta: delta.thinking || '',
      toolInputDelta: '',
    }
  }
  if (delta?.type === 'tool_use_input_delta' || delta?.type === 'input_json_delta') {
    return {
      textDelta: '',
      reasoningDelta: '',
      toolInputDelta: delta.partial_json || '',
    }
  }
  return {
    textDelta: '',
    reasoningDelta: '',
    toolInputDelta: '',
  }
}
```

- [ ] **Step 3: Replace inline finalStopReason type**

In `AnthropicProvider.ts`, replace:

```ts
      let finalStopReason: import('../../../shared/types/provider').AgentStopReason = 'unknown'
```

with:

```ts
      let finalStopReason: AgentStopReason = 'unknown'
```

- [ ] **Step 4: Replace stop-reason mapping in the stream loop**

In the `message_delta` branch, replace:

```ts
                const stopReason = json.delta?.stop_reason
                if (stopReason) {
                  if (stopReason === 'end_turn' || stopReason === 'stop_sequence') finalStopReason = 'stop'
                  else if (stopReason === 'max_tokens') finalStopReason = 'length'
                  else if (stopReason === 'tool_use') finalStopReason = 'tool_calls'
                }
```

with:

```ts
                const stopReason = json.delta?.stop_reason
                if (stopReason) {
                  finalStopReason = mapAnthropicStopReason(stopReason)
                }
```

- [ ] **Step 5: Replace content delta parsing in the stream loop**

In the `content_block_delta` branch, replace:

```ts
                if (json.delta?.type === 'text_delta') {
                  const text = json.delta.text
                  fullContent += text
                  callbacks.onChunk(text, '')
                } else if (json.delta?.type === 'tool_use_input_delta') {
                  currentToolCallArgs += json.delta.partial_json
                }
```

with:

```ts
                const deltaParts = extractAnthropicDelta(json.delta)
                if (deltaParts.textDelta) {
                  fullContent += deltaParts.textDelta
                  callbacks.onChunk(deltaParts.textDelta, '')
                }
                if (deltaParts.reasoningDelta) {
                  callbacks.onChunk('', deltaParts.reasoningDelta)
                }
                if (deltaParts.toolInputDelta) {
                  currentToolCallArgs += deltaParts.toolInputDelta
                }
```

- [ ] **Step 6: Run targeted tests**

Run:

```bash
npm test -- src/tests/chat-service.test.ts
```

Expected: PASS for all tests in `chat-service.test.ts`.

- [ ] **Step 7: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit this task if the workflow allows commits**

Only commit if the user explicitly requested commits for this implementation session. Otherwise skip the commit step and continue.

```bash
git add src/main/services/chat/AnthropicProvider.ts src/tests/chat-service.test.ts
git commit -m "fix: parse Anthropic thinking deltas and stop reasons"
```

---

### Task 5: Run full verification and report result

**Files:**
- No code changes expected.
- Verify: whole project test/typecheck suite.

**Interfaces:**
- Consumes: completed Tasks 1-4.
- Produces: final verification result for the user.

- [ ] **Step 1: Run all tests**

Run:

```bash
npm test
```

Expected: PASS. If a test unrelated to this change fails, capture the failing test name and exact error output before deciding whether to fix or report it.

- [ ] **Step 2: Run TypeScript typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Inspect git diff**

Run:

```bash
git diff -- src/main/services/chat/utils.ts src/main/services/chat/AnthropicProvider.ts src/tests/chat-service.test.ts docs/superpowers/specs/2026-07-06-anthropic-provider-compatibility-design.md docs/superpowers/plans/2026-07-06-anthropic-provider-compatibility.md
```

Expected: Diff only contains the approved design document, this plan, the thinking payload change, the Anthropic stream helper/parser change, and tests.

- [ ] **Step 4: Final report**

Report to the user:

```text
Implemented Anthropic provider compatibility fix.

Changed:
- buildThinkingPayload now uses adaptive thinking for current Claude models and preserves budget_tokens for older Claude models.
- AnthropicProvider now maps refusal/safety/pause_turn and streams thinking_delta to reasoningDelta.
- Added regression tests for payload and parser helpers.

Verification:
- npm test: PASS
- npm run typecheck: PASS
```

If any verification command fails, report the failing command and exact failure instead of claiming completion.

- [ ] **Step 5: Commit final verification if the workflow allows commits**

Only commit if the user explicitly requested commits for this implementation session. Otherwise skip the commit step.

```bash
git add src/main/services/chat/utils.ts src/main/services/chat/AnthropicProvider.ts src/tests/chat-service.test.ts docs/superpowers/specs/2026-07-06-anthropic-provider-compatibility-design.md docs/superpowers/plans/2026-07-06-anthropic-provider-compatibility.md
git commit -m "fix: update Anthropic provider compatibility"
```

---

## Self-Review

- Spec coverage: The plan covers adaptive thinking payloads, preserving old-model `budget_tokens`, Anthropic thinking delta streaming, stop reason normalization, tests, and verification commands.
- Placeholder scan: No `TBD`, `TODO`, vague edge-case instructions, or "similar to" references remain.
- Type consistency: `AgentStopReason` matches `src/shared/types/provider.ts`; helper return shapes are used consistently in tests and provider implementation.
- Scope check: The plan is limited to the three approved implementation files plus the approved spec and this plan document.
