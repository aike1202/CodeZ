// src/main/services/prompts/sections/PendingFeatures.ts
export const PENDING_FEATURES_SECTION = `<pending_features>
  The following features are planned but NOT YET IMPLEMENTED.
  Do NOT attempt to use functionality related to them.
</pending_features>`

export function buildPendingFeatures(): string {
  return PENDING_FEATURES_SECTION
}
