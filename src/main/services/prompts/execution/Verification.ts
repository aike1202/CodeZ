import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Verification

- Scale verification to risk. Inspect the edit result for trivial changes, run focused tests for behavioral changes, and use broader tests/typecheck/build for shared contracts or cross-module work.
- Prefer the smallest command that gives meaningful confidence. If it fails, diagnose from the real output and verify the correction.
- Never invent results or imply a check passed when it was not run. State any skipped or blocked verification clearly.`

export const VerificationModule: PromptModule = {
  id: 'verification',
  layer: 'execution',
  priority: 2,
  build: () => TEXT,
}
