# Pattern Permission With Hardline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace risk-driven approvals with capability-pattern rules while preserving a non-bypassable Hardline layer.

**Architecture:** `CriticalOperationGuard` remains the first forced-ask layer. Normal tool and shell operations become `PermissionCheck` values evaluated by mode defaults plus remembered wildcard rules; `riskLevel` remains compatibility metadata only.

**Tech Stack:** TypeScript, Electron, React, Vitest, web-tree-sitter

## Global Constraints

- Preserve all unrelated dirty-worktree changes.
- Do not commit unless the user explicitly requests it.
- Keep `riskLevel` and `critical` readable for existing renderer state and audit records.
- Hardline approvals are once-only and cannot be persisted or bypassed by wildcard allow rules.
- Parser or expansion uncertainty must never become Hardline without independent critical evidence.

---

### Task 1: Add Permission Capability Contracts

**Files:**
- Modify: `src/shared/types/permission.ts`
- Modify: `src/tests/permission-contracts.test.ts`
- Modify: `src/tests/permission-approval-options.test.ts`

**Interfaces:**
- Produces: `PermissionCapability`, `PermissionAnalysisStatus`, `PermissionCheck`, and Hardline-based approval scopes.

- [ ] Add failing contract tests asserting Hardline is once-only while a normal unparsed ask supports all three scopes.
- [ ] Extend the shared types with:

```ts
export type PermissionCapability =
  | 'read' | 'edit' | 'shell' | 'shell_unparsed' | 'network'
  | 'external_effect' | 'external_directory' | 'delete' | 'rollback'
  | 'unknown' | 'hardline'

export type PermissionAnalysisStatus = 'parsed' | 'unparsed'

export interface PermissionCheck {
  permission: PermissionCapability
  pattern: string
  action: PermissionAction
  reason: string
}
```

- [ ] Add `permission`, `checks`, `analysisStatus`, and `hardline` to `PermissionDecision`.
- [ ] Replace `allowedScopesForRisk` decision usage with:

```ts
export function allowedScopesForDecision(hardline: boolean): PermissionApprovalScope[] {
  return hardline ? ['once'] : ['once', 'session', 'workspace']
}
```

- [ ] Keep `allowedScopesForRisk` exported as a compatibility wrapper.
- [ ] Run `npm.cmd test -- --run src/tests/permission-contracts.test.ts src/tests/permission-approval-options.test.ts` and expect PASS.

### Task 2: Implement Wildcard Rule Matching

**Files:**
- Create: `src/main/services/permission/PermissionPattern.ts`
- Modify: `src/main/services/permission/PermissionRuleStore.ts`
- Modify: `src/tests/permission-rule-store.test.ts`

**Interfaces:**
- Produces: `matchPermissionPattern(value: string, pattern: string): boolean`.
- Changes persisted rule identity to `{ permission, pattern }`.

- [ ] Add failing tests for `*` wildcard matching, literal regex characters, last-match precedence, capability separation, session isolation, and legacy rules without `permission`.
- [ ] Implement literal-safe wildcard matching:

```ts
export function matchPermissionPattern(value: string, pattern: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`).test(value)
}
```

- [ ] Add `permission: PermissionCapability` to new stored rules and remember inputs.
- [ ] Interpret legacy rules without `permission` as `shell`.
- [ ] Resolve workspace rules followed by session rules and return the last matching action.
- [ ] Run `npm.cmd test -- --run src/tests/permission-rule-store.test.ts` and expect PASS.

### Task 3: Convert the Decision Engine to Capability Defaults

**Files:**
- Modify: `src/main/services/permission/PermissionDecisionEngine.ts`
- Create: `src/tests/permission-decision-engine.test.ts`

**Interfaces:**
- Consumes: mode, permission capability, and optional explicit rule.
- Produces: per-check action and aggregate action.

- [ ] Add failing tests for every auto-mode default, full-access defaults, explicit allow/deny, and aggregation precedence.
- [ ] Replace risk-based `decide` with:

```ts
decide(input: {
  mode: PermissionMode
  permission: PermissionCapability
  explicitRule?: 'allow' | 'deny' | null
}): { action: PermissionAction }
```

- [ ] Implement auto defaults: read/edit/shell allow; all other normal capabilities ask.
- [ ] Implement full-access defaults: all normal capabilities allow.
- [ ] Add `aggregate(checks)` with deny > ask > allow precedence.
- [ ] Run `npm.cmd test -- --run src/tests/permission-decision-engine.test.ts` and expect PASS.

### Task 4: Make Command Classification Side-Effect First

**Files:**
- Modify: `src/main/services/permission/commandPolicies.ts`
- Modify: `src/tests/permission-critical-guard.test.ts`
- Modify: `src/tests/permission-command-corpus.test.ts`

**Interfaces:**
- Extends `CommandAssessment` with `permission: PermissionCapability`.

- [ ] Add failing exact-result tests for pure version queries and side-effect commands containing version tokens.
- [ ] Add `permission` to every assessment.
- [ ] Evaluate install, network, platform, delete, and destructive Git branches before pure version-query recognition.
- [ ] Recognize version queries only through exact executable-specific argv shapes.
- [ ] Assert:

```ts
classifyKnownCommand(['cargo', 'install', 'ripgrep', '--version', '14.1.0'])?.permission === 'network'
classifyKnownCommand(['docker', 'run', 'node:22', '--version'])?.permission === 'external_effect'
classifyKnownCommand(['npm', '--version'])?.permission === 'shell'
```

- [ ] Replace the corpus percentage-only assertion with expected capability/risk rows while retaining a coverage check.
- [ ] Run the two focused test files and expect PASS.

### Task 5: Restrict Hardline to Evidence-Based Critical Operations

**Files:**
- Modify: `src/main/services/permission/CriticalOperationGuard.ts`
- Modify: `src/tests/permission-critical-guard.test.ts`

**Interfaces:**
- Produces Hardline `PermissionDecision` values with `hardline: true`, `permission: 'hardline'`, and one ask check.

- [ ] Add failing tests proving parser diagnostics and unknown commands do not return Hardline.
- [ ] Remove the `operation.dynamic && graph.diagnostics.length > 0` Hardline branch.
- [ ] Detect force push directly from parsed argv before any version metadata can interfere.
- [ ] Populate the new decision fields and preserve `riskLevel: 4` / `critical: true` compatibility.
- [ ] Run `npm.cmd test -- --run src/tests/permission-critical-guard.test.ts` and expect PASS.

### Task 6: Integrate Pattern Checks in PermissionManager

**Files:**
- Modify: `src/main/services/PermissionManager.ts`
- Modify: `src/tests/permission-manager.test.ts`
- Modify: `src/tests/permission-operation-analysis.test.ts`

**Interfaces:**
- Consumes per-operation assessments, rule-store matches, nested expansion snapshots, and Hardline results.
- Produces aggregate `PermissionDecision` values.

- [ ] Replace tests expecting `npm version`, unknown scripts, or expansion failures to be L4 with normal `shell_unparsed` asks.
- [ ] Add compound tests where every operation produces an independent check and the highest action aggregates correctly.
- [ ] Add a helper that creates a check, resolves its remembered rule, and calls the new decision engine.
- [ ] For shell operations, create checks from `operation.source` and assessment capability; unknown parsed operations use `shell`.
- [ ] Add a `shell_unparsed` check when parser diagnostics or `opaqueReason` exist.
- [ ] Keep successful nested expansion only for Hardline scanning and snapshots.
- [ ] For non-shell tools, map reads, edits, web, rollback, and unknown tools to capabilities.
- [ ] Generate request scopes with `allowedScopesForDecision(decision.hardline)`.
- [ ] Remember each asked check by `{ permission, pattern }`; never remember Hardline.
- [ ] Run `npm.cmd test -- --run src/tests/permission-manager.test.ts src/tests/permission-operation-analysis.test.ts` and expect PASS.

### Task 7: Support Package-Manager Directory Options

**Files:**
- Modify: `src/main/services/permission/NestedCommandExpander.ts`
- Modify: `src/tests/permission-operation-analysis.test.ts`

**Interfaces:**
- Produces script lookup `{ packageRoot, scriptName }` for supported npm/pnpm/yarn/bun layouts.

- [ ] Add failing tests for npm `--prefix`, pnpm `-C`/`--dir`, yarn `--cwd`, and bun `--cwd`.
- [ ] Parse only the listed option forms and leave unsupported layouts as `opaqueReason`.
- [ ] Read `package.json` from the selected package root and retain snapshot hashing.
- [ ] Keep pure exact version queries non-opaque.
- [ ] Run `npm.cmd test -- --run src/tests/permission-operation-analysis.test.ts` and expect PASS.

### Task 8: Update Approval UI

**Files:**
- Modify: `src/renderer/src/components/chat/PermissionApprovalWidget.tsx`
- Modify: `src/renderer/src/components/chat/PermissionApprovalWidget.css`
- Modify: `src/renderer/src/components/chat/permissionApprovalOptions.ts`
- Modify: `src/tests/permission-approval-options.test.ts`

**Interfaces:**
- Consumes `hardline`, `analysisStatus`, `checks`, and `allowedScopes`.

- [ ] Add tests proving scope options depend on `hardline`, not risk level.
- [ ] Display `极度危险`, `无法完整分析`, or `需要授权` as the primary label.
- [ ] Render every ask check as `permission: pattern`.
- [ ] Add an amber unparsed class while preserving the red Hardline class.
- [ ] Run `npm.cmd test -- --run src/tests/permission-approval-options.test.ts` and expect PASS.

### Task 9: Run Permission Regression Suite

**Files:**
- Verify only.

**Interfaces:**
- Validates the completed permission pipeline.

- [ ] Run all permission tests with `npm.cmd test -- --run src/tests/permission-*.test.ts` or an explicit file list if the shell does not expand the glob.
- [ ] Run `npm.cmd run typecheck`.
- [ ] Run `git diff --check` on touched permission, renderer, test, and documentation files.
- [ ] Review the final diff to ensure no unrelated dirty-worktree changes were modified.

