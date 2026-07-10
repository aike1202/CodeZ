export interface ContextFeatureFlags {
  shadowLedger: boolean
  authoritativeLedger: boolean
  compaction: boolean
}

export function readContextFeatureFlags(
  env: Record<string, string | undefined> = process.env
): ContextFeatureFlags {
  return {
    shadowLedger: env.CODEZ_CONTEXT_SHADOW_LEDGER === '1',
    authoritativeLedger: env.CODEZ_CONTEXT_AUTHORITATIVE_LEDGER !== '0',
    compaction: env.CODEZ_CONTEXT_COMPACTION !== '0'
  }
}
