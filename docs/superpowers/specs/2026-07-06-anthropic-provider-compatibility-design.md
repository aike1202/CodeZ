# Anthropic Provider Compatibility Design

Date: 2026-07-06

## Summary

Fix the current Anthropic provider compatibility issues with newer Claude models while keeping the existing provider abstraction intact. The work focuses on the minimum safe change set: thinking payload generation, Anthropic SSE parsing, stop reason normalization, and regression tests.

## Goals

- Stop sending `thinking: { type: "enabled", budget_tokens: ... }` to Claude models that now require adaptive thinking.
- Preserve old `budget_tokens` behavior for older Claude models that still need it.
- Stream Anthropic thinking deltas into the existing `reasoningDelta` callback path.
- Normalize newer Anthropic stop reasons such as `refusal` and `pause_turn`.
- Update tests so the compatibility behavior is locked in.

## Non-goals

- Do not migrate Anthropic calls to `@anthropic-ai/sdk`.
- Do not change Provider settings UI.
- Do not add `xhigh` or `max` effort options in this pass.
- Do not implement compaction, Files API, Managed Agents, or server-side tool fallback.
- Do not change OpenAI or Gemini provider behavior.

## Current Architecture

The runtime flow remains unchanged:

```text
Renderer
  -> preload chat.stream()
  -> IPC chat.handlers
  -> AgentRunner
  -> ChatService
  -> ChatProviderFactory
  -> AnthropicProvider
  -> fetch /v1/messages stream
```

The changes are isolated to:

- `src/main/services/chat/utils.ts`
- `src/main/services/chat/AnthropicProvider.ts`
- `src/tests/chat-service.test.ts`

## Design

### 1. Thinking payload compatibility

`buildThinkingPayload()` will keep its provider-specific branching. Inside the Anthropic branch, add a small model classifier for models that require adaptive thinking only.

Adaptive-only models include:

- `claude-opus-4-8`
- `claude-opus-4-7`
- `claude-sonnet-5`
- `claude-fable-5`
- `claude-mythos-5`

For these models, when thinking is enabled, emit:

```ts
{
  thinking: {
    type: 'adaptive',
    display: 'summarized',
  },
  output_config: {
    effort: 'low' | 'medium' | 'high',
  },
}
```

The `output_config` block is included only when the existing config has a supported effort value. If the user selects `custom` with `budgetTokens`, the adaptive-only branch still does not send `budget_tokens`.

For older Anthropic models, preserve the current budget-token behavior:

```ts
{
  thinking: {
    type: 'enabled',
    budget_tokens: number,
  },
}
```

This keeps the fix narrow and avoids changing behavior for older configured models.

### 2. Anthropic SSE parser

Extend `AnthropicProvider` stream parsing without replacing the existing fetch/SSE implementation.

#### Text deltas

Keep the current behavior:

```ts
text_delta -> callbacks.onChunk(text, '')
```

#### Thinking deltas

Handle Anthropic thinking deltas:

```ts
thinking_delta -> callbacks.onChunk('', thinkingText)
```

The primary field is `json.delta.thinking`. The implementation may read defensively from adjacent fields if present, but must not invent a new response shape.

#### Tool input deltas

Keep the existing `tool_use_input_delta` behavior and also accept `input_json_delta` when its payload contains `partial_json`.

#### Stop reasons

Map Anthropic stop reasons into the existing internal `AgentStopReason` values:

| Anthropic stop reason | Internal stop reason |
| --- | --- |
| `end_turn` | `stop` |
| `stop_sequence` | `stop` |
| `max_tokens` | `length` |
| `tool_use` | `tool_calls` |
| `refusal` | `content_filter` |
| `safety` | `content_filter` |
| `pause_turn` | `tool_calls` |

`pause_turn` is not fully supported by the current runtime, but mapping it to `tool_calls` avoids treating it as a clean final answer.

## Error Handling

HTTP errors remain surfaced through the existing callback:

```ts
callbacks.onError(`请求失败 (${response.status}): ...`)
```

This design intentionally does not add Claude Fable 5 server-side fallback or detailed refusal recovery. `refusal` is normalized to `content_filter` so the UI/runtime can distinguish it from a normal stop.

JSON parsing for streaming events remains best-effort and tolerant of partial/non-JSON lines. Existing message-to-Anthropic conversion behavior remains unchanged except where stream event parsing requires defensive handling.

## Tests

Update `src/tests/chat-service.test.ts` with regression coverage:

1. New Claude models use adaptive thinking:
   - Input: `claude-opus-4-8`, Anthropic thinking enabled, `effort: 'high'`
   - Expect: `thinking.type === 'adaptive'`, `display === 'summarized'`, `output_config.effort === 'high'`
   - Expect no `budget_tokens`

2. Custom budget on new Claude models does not send budget tokens:
   - Input: `claude-opus-4-8`, `effort: 'custom'`, `budgetTokens: 2000`
   - Expect adaptive thinking, no `budget_tokens`

3. Older Claude models preserve budget-token behavior:
   - Input: `claude-3-7-sonnet`, `effort: 'custom'`, `budgetTokens: 2000`
   - Expect `thinking: { type: 'enabled', budget_tokens: 2000 }`

4. Existing OpenAI/Gemini thinking tests continue to pass.

If the current test structure makes stream parser tests straightforward, add a focused Anthropic SSE parser test. If not, keep this pass scoped to payload tests and rely on typecheck plus manual provider smoke test for stream parsing.

## Verification

After implementation, run:

```bash
npm test
npm run typecheck
```

Manual smoke test, if credentials are available:

- Configure an Anthropic provider with `claude-opus-4-8`.
- Enable thinking.
- Send a simple prompt.
- Confirm no `budget_tokens` 400 occurs.
- Confirm text streams normally.
- Confirm reasoning deltas, if emitted, reach the reasoning UI path.

## Risks

- `display: 'summarized'` may produce more visible reasoning text than before. This is intentional because the app already has a reasoning stream path; using the default omitted display would make thinking appear stalled or empty.
- The adaptive-only classifier is a conservative whitelist. A future Anthropic model may need to be added later.
- `pause_turn` is only normalized, not resumed. Full pause-turn continuation is a later runtime feature.

## Rollback

The change is limited to three files and can be reverted by restoring:

- `src/main/services/chat/utils.ts`
- `src/main/services/chat/AnthropicProvider.ts`
- `src/tests/chat-service.test.ts`
