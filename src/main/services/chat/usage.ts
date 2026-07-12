import type { ProviderTokenUsage } from '../../../shared/types/provider'

/** Merges cumulative and segmented provider usage events without losing earlier fields. */
export function mergeProviderUsage(
  previous: ProviderTokenUsage | undefined,
  next: ProviderTokenUsage
): ProviderTokenUsage {
  const inputTokens = Math.max(previous?.inputTokens || 0, next.inputTokens || 0)
  const outputTokens = Math.max(previous?.outputTokens || 0, next.outputTokens || 0)
  const reasoningTokens = Math.max(previous?.reasoningTokens || 0, next.reasoningTokens || 0)
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: Math.max(
      previous?.totalTokens || 0,
      next.totalTokens || 0,
      inputTokens + outputTokens + reasoningTokens
    )
  }
}
