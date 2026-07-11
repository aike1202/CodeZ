# Package Manager Version Permission Implementation Plan

> **For agentic workers:** Execute this plan inline and verify each test boundary before continuing.

**Goal:** Prevent package-manager version queries from being misclassified as hidden dynamic commands.

**Architecture:** Recognize version-only invocations at the package-manager boundary in `NestedCommandExpander`. Leave the risk engine and unknown-script handling unchanged so only statically safe version queries are affected.

**Tech Stack:** TypeScript, Vitest, Electron main-process permission services

## Global Constraints

- Keep `critical.hidden.dynamic-command` protection for genuinely opaque commands.
- Do not change permission UI copy or risk-level definitions.
- Avoid unrelated changes in the existing dirty worktree.

---

### Task 1: Add regression coverage

**Files:**
- Modify: `src/tests/permission-operation-analysis.test.ts`
- Modify: `src/tests/permission-manager.test.ts`

**Interfaces:**
- Consumes: `NestedCommandExpander.expandCommand(...)` and `PermissionManager.evaluateToolCall(...)`
- Produces: Regression expectations for package-manager version queries

- [x] Add a parameterized expander test asserting `npm -v`, `pnpm --version`, `yarn -v`, and `bun -version` return `command: null`, `shell: null`, and no `opaqueReason`.
- [x] Add a manager test for `node -v; npm -v; pnpm -v; yarn -v; cargo -v` under PowerShell, asserting risk level `0`, `critical: false`, and action `allow`.
- [x] Add negative expander and manager cases for bare `version`, `-V`, trailing arguments, and an unknown script; assert they remain opaque and L4.
- [x] Run `npm.cmd test -- --run src/tests/permission-operation-analysis.test.ts src/tests/permission-manager.test.ts` and confirm the new regression fails before implementation.

### Task 2: Correct package-manager expansion

**Files:**
- Modify: `src/main/services/permission/NestedCommandExpander.ts`

**Interfaces:**
- Consumes: package-manager executable and first argument from `argv`
- Produces: no-op expansion for version-only invocations

- [x] Add a local version-argument set containing `-v`, `--version`, and `-version`; intentionally exclude the potentially mutating `version` subcommand.
- [x] Return an empty non-opaque expansion before package-script lookup only when the raw argument exactly matches the allowlist and `argv.length === 2`.
- [x] Re-run the two focused test files and confirm all tests pass.
- [x] Run `npm.cmd run typecheck` to verify TypeScript compatibility.
