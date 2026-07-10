import { describe, expect, it } from 'vitest'
import {
  MAIN_CONTEXT_SCOPE,
  contextScopeForSubAgent,
  eventChangesHistory,
  type ContextBudgetSnapshot,
  type SessionRuntimeSnapshot
} from '../shared/types/context'
import { readContextFeatureFlags } from '../main/services/context/ContextFeatureFlags'

describe('context contracts', () => {
  it('defaults to the authoritative ledger and compaction after rollout', () => {
    expect(readContextFeatureFlags({})).toEqual({
      shadowLedger: false,
      authoritativeLedger: true,
      compaction: true
    })
    expect(readContextFeatureFlags({
      CODEZ_CONTEXT_SHADOW_LEDGER: '1',
      CODEZ_CONTEXT_AUTHORITATIVE_LEDGER: '0',
      CODEZ_CONTEXT_COMPACTION: '0'
    })).toEqual({ shadowLedger: true, authoritativeLedger: false, compaction: false })
  })

  it('uses stable main and subagent scope ids', () => {
    expect(MAIN_CONTEXT_SCOPE).toBe('main')
    expect(contextScopeForSubAgent('run-7')).toBe('subagent:run-7')
    expect(() => contextScopeForSubAgent(' ')).toThrow('runId is required')
  })

  it('only advances history versions for model-view events', () => {
    expect(eventChangesHistory('user_message')).toBe(true)
    expect(eventChangesHistory('compaction_completed')).toBe(true)
    expect(eventChangesHistory('compaction_started')).toBe(false)
    expect(eventChangesHistory('turn_completed')).toBe(false)
  })

  it('constructs the minimum valid budget and snapshot shapes', () => {
    const budget: ContextBudgetSnapshot = {
      hardInputLimit: 7000,
      usableInputBudget: 6744,
      systemPromptTokens: 10,
      toolSchemaTokens: 10,
      instructionTokens: 10,
      protocolTokens: 10,
      summaryTokens: 0,
      recentHistoryTokens: 10,
      currentInputTokens: 10,
      outputReserveTokens: 1000,
      safetyMarginTokens: 256,
      totalInputTokens: 60,
      pressureLevel: 'normal',
      estimateSource: 'heuristic',
      historyVersion: 1
    }
    const snapshot: SessionRuntimeSnapshot = {
      schemaVersion: 1,
      sessionId: 's1',
      throughSequence: 0,
      createdAt: '2026-07-10T00:00:00.000Z',
      scopes: {}
    }

    expect(budget.usableInputBudget).toBe(6744)
    expect(snapshot.schemaVersion).toBe(1)
  })
})
