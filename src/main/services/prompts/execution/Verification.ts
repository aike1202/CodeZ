import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Verification

## Purpose
Define how to confirm a change works — choose the right level of evidence for the risk.

## Verification Levels
Choose the smallest level that provides sufficient confidence:

| Level | Method | When to use |
|-------|--------|-------------|
| L1 — Reasoning | Logic-check the change mentally. Trace the data flow. | Trivial changes, typo fixes. |
| L2 — Inspect | Inspect the structured Edit or Write result and its diff when present; otherwise combine the returned hash with the smallest appropriate check. Confirm each edit is intentional and complete. | Single-file changes with no behavioral impact. |
| L3 — Affected tests | Run the test suite for the changed module. | Any behavioral change or new logic. |
| L4 — Full validation | Run the full test suite + typecheck + build. | Cross-module changes, API changes, architectural refactors. |

## Policy
- Escalate when uncertain — if L2 feels insufficient, go to L3.
- If verification fails, use the real command output to fix the issue, then verify again.
- Prefer running the smallest relevant command over always running the heaviest one.

## Exceptions
- Documentation-only changes may skip L3–L4.
- When the user explicitly says to skip verification, honor that — but note it in the completion.

## Never
- Never claim completion if verification failed or was skipped without noting it.
- Never fabricate test results, command output, or file contents.

## Golden Rule
Never claim success without evidence.`

export const VerificationModule: PromptModule = {
  id: 'verification',
  layer: 'execution',
  priority: 2,
  build: async (ctx: PromptContext) => {
    const { VerificationStrategyService } = await import('../../VerificationStrategyService')
    const scripts = await VerificationStrategyService.readPackageScripts(ctx.workspaceRoot)
    const section = VerificationStrategyService.formatPromptSection(scripts)
    if (!section) return TEXT
    return TEXT + '\n\n' + section
  },
}
