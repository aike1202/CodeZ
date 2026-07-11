# Read Initial Range Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop arbitrary first-50/100-line reads while preserving evidence-based range reads.

**Architecture:** Add a model-facing decision rule to `ReadTool.description`, then repeat it in ToolPolicy and Investigation. Regression tests cover both the tool description and assembled system prompt; the Read schema and execution remain unchanged.

**Tech Stack:** TypeScript, prompt modules, Vitest.

## Global Constraints

- Do not change the `Read` schema structure, defaults, or execution implementation; parameter descriptions may be clarified.
- Do not remove `offset` or `limit`.
- Do not change existing read budgets.
- Do not modify historical design documents.
- Do not commit unless explicitly requested.

---

### Task 1: Lock the Initial-Read Rule With Tests

**Files:**
- Modify: `src/tests/read-tool.test.ts`
- Modify: `src/tests/system-prompt-service.test.ts`

**Interfaces:**
- Consumes: `ReadTool.description` and `SystemPromptService.buildSystemPrompt()`.
- Produces: regression assertions for default full reads and evidence-based range exceptions.

- [x] **Step 1: Add failing description assertions**

Require the tool description to say initial reads without an evidence-based relevant range omit `offset`/`limit`, arbitrary first-50/100-line browsing is forbidden, and ranges require a known relevant range, truncation or a documented budget boundary, or context trimming.

- [x] **Step 2: Add failing assembled-prompt assertions**

Require ToolPolicy and Investigation content to carry the same default and exceptions.

- [x] **Step 3: Run targeted tests and verify failure**

Run: `npm.cmd test -- src/tests/read-tool.test.ts src/tests/system-prompt-service.test.ts`

Expected: the new assertions fail against the previous policy text.

### Task 2: Align Tool and Prompt Rules

**Files:**
- Modify: `src/main/tools/builtin/ReadTool.ts`
- Modify: `src/main/services/prompts/execution/ToolPolicy.ts`
- Modify: `src/main/services/prompts/execution/Investigation.ts`

**Interfaces:**
- Produces: one consistent initial-read range policy without runtime changes.

- [x] **Step 1: Update `ReadTool.description`**

State that initial reads without an evidence-based relevant range omit range arguments, explicitly permit known ranges on a first read, and list the three permitted range-read cases.

- [x] **Step 2: Update ToolPolicy and Investigation**

Add the same default and prohibit arbitrary first-50/100-line probing.

- [x] **Step 3: Run targeted tests**

Run: `npm.cmd test -- src/tests/read-tool.test.ts src/tests/system-prompt-service.test.ts`

Expected: all targeted tests pass.

### Task 3: Regression Verification

**Files:**
- Verify only.

**Interfaces:**
- Consumes: completed prompt-only changes.
- Produces: verified test and build output.

- [x] **Step 1: Run full tests**

Run: `npm.cmd test`

Expected: all tests pass.

- [x] **Step 2: Run typecheck and build**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run build`

Expected: both pass, with only pre-existing build warnings.

- [x] **Step 3: Review focused diff**

Verify that only descriptions, prompt text, tests, and new docs changed for this task; `ReadTool.parameters_schema` structure/defaults and `execute` remain unchanged.
