# Shared Agent Tool Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the main Agent, Research, ExecutionPlanner, and Executor consume the same tool-use policy modules while preserving role-specific permissions and output contracts.

**Architecture:** Export one `SHARED_TOOL_USE_MODULES` collection and `buildSharedToolUsePrompt()` from `SubAgentPrompts.ts`. Register that collection in the main and Executor pipelines, and prepend its rendered prompt to the two standalone read-only subagent prompts. Keep role prompts responsible only for task scope, permissions, and output format.

**Tech Stack:** TypeScript, prompt modules, Vitest.

## Global Constraints

- Share `SecurityModule`, `HarnessModule`, `InvestigationModule`, `FailureRecoveryModule`, and `ToolPolicyModule` from one source.
- Do not unify Agent identity, permissions, loop budgets, task scope, or output protocols.
- Do not add write tools to Research or ExecutionPlanner.
- Do not change `Read` schema, execution logic, content budgets, or runtime enforcement.
- Do not modify unrelated UI or permission code.
- Do not commit unless explicitly requested.

---

### Task 1: Lock Shared Policy Coverage With Tests

**Files:**
- Create: `src/tests/subagent-shared-tool-policy.test.ts`
- Modify: `src/tests/research-subagent-prompt.test.ts`

**Interfaces:**
- Consumes: `SubAgentManager.getDetail(type)`, `SHARED_TOOL_USE_MODULES`, and each subagent `systemPromptBuilder`.
- Produces: integration coverage proving every built-in Agent receives the exact shared module text.

- [x] **Step 1: Add the failing shared-policy integration test**

Create a test that builds prompt details for `Research`, `ExecutionPlanner`, and `Executor`, renders every module in `SHARED_TOOL_USE_MODULES`, and requires each rendered section to appear unchanged in every final system prompt. Also require Research and ExecutionPlanner tool lists to exclude `Edit` and `Write`.

- [x] **Step 2: Update the Research prompt test for asynchronous composition**

Change the test callback to `async`, await `ResearchSubAgent.systemPromptBuilder(...)`, and assert the final prompt contains `# Tool Policy`, the batching rule, and the initial-read range rule.

- [x] **Step 3: Run tests and verify failure**

Run: `npm.cmd test -- src/tests/subagent-shared-tool-policy.test.ts src/tests/research-subagent-prompt.test.ts src/tests/executor-subagent-prompt.test.ts`

Expected: FAIL because `SHARED_TOOL_USE_MODULES` is not exported and Research/ExecutionPlanner do not include the common policy.

---

### Task 2: Share Tool Modules Across Every Agent

**Files:**
- Modify: `src/main/services/prompts/SubAgentPrompts.ts`
- Modify: `src/main/services/prompts/PromptBuilder.ts`
- Modify: `src/main/agent/definitions/ResearchSubAgent.ts`
- Modify: `src/main/agent/definitions/ExecutionPlannerSubAgent.ts`

**Interfaces:**
- Produces: `SHARED_TOOL_USE_MODULES: PromptModule[]`.
- Produces: `buildSharedToolUsePrompt(ctx: PromptContext): Promise<string>`.
- Preserves: `buildExecutorSharedPrompt(ctx: PromptContext): Promise<string>`.

- [x] **Step 1: Export the shared module collection and builder**

In `SubAgentPrompts.ts`, define:

```ts
export const SHARED_TOOL_USE_MODULES: PromptModule[] = [
  SecurityModule,
  HarnessModule,
  InvestigationModule,
  FailureRecoveryModule,
  ToolPolicyModule,
]

export async function buildSharedToolUsePrompt(ctx: PromptContext): Promise<string> {
  return new PromptPipeline().registerAll(SHARED_TOOL_USE_MODULES).run(ctx)
}
```

Use `.registerAll(SHARED_TOOL_USE_MODULES)` in `createExecutorPipeline()` and remove duplicate individual registration of those five modules.

- [x] **Step 2: Register the same collection in the main pipeline**

Import `SHARED_TOOL_USE_MODULES` in `PromptBuilder.ts`, replace the five individual registrations with one `.registerAll(SHARED_TOOL_USE_MODULES)`, and remove their direct imports.

- [x] **Step 3: Compose Research with the shared prompt**

Make `ResearchSubAgent.systemPromptBuilder` async, build a `PromptContext` from the subagent context, call `buildSharedToolUsePrompt`, and return `[sharedPrompt, researchPrompt].join('\n\n')`.

- [x] **Step 4: Compose ExecutionPlanner with the shared prompt**

Apply the same asynchronous composition to `ExecutionPlannerSubAgent.systemPromptBuilder` without changing its tools, output spec, or loop budget.

- [x] **Step 5: Run targeted tests**

Run: `npm.cmd test -- src/tests/subagent-shared-tool-policy.test.ts src/tests/research-subagent-prompt.test.ts src/tests/executor-subagent-prompt.test.ts`

Expected: shared module coverage passes; role-conflict assertions may still fail until Task 3.

---

### Task 3: Make Shared Text Role-Neutral and Remove Overrides

**Files:**
- Modify: `src/main/services/prompts/execution/Investigation.ts`
- Modify: `src/main/services/prompts/execution/ToolPolicy.ts`
- Modify: `src/main/agent/definitions/ResearchSubAgent.ts`
- Modify: `src/main/agent/definitions/ExecutionPlannerSubAgent.ts`
- Modify: `src/tests/subagent-shared-tool-policy.test.ts`

**Interfaces:**
- Preserves: identical shared module text across all Agent prompts.
- Produces: role prompts without competing read-range guidance.

- [x] **Step 1: Make Investigation role-neutral**

Change the purpose and final workflow wording so it applies before conclusions or edits, and replace the edit-only golden rule with `Plan reads, batch known targets, then act within your role.`

- [x] **Step 2: Clarify ToolPolicy does not grant tools**

Add: `Use only tools available to your role; this policy guides selection and does not grant additional capabilities.`

- [x] **Step 3: Remove Research and ExecutionPlanner overrides**

Replace role-local “specific files/ranges”, “do not dump entire files”, and “spot-check” guidance with a short instruction to follow the shared tool policy and keep only the final report concise.

- [x] **Step 4: Assert conflicting phrases are absent**

Require Research and ExecutionPlanner prompts not to contain their old range/spot-check instructions while retaining their read-only role constraints.

- [x] **Step 5: Run targeted tests**

Run: `npm.cmd test -- src/tests/subagent-shared-tool-policy.test.ts src/tests/research-subagent-prompt.test.ts src/tests/executor-subagent-prompt.test.ts src/tests/system-prompt-service.test.ts`

Expected: all targeted tests pass.

---

### Task 4: Regression Verification

**Files:**
- Verify only.

**Interfaces:**
- Consumes: completed shared prompt implementation.
- Produces: verified production-ready result.

- [x] **Step 1: Run full tests**

Run: `npm.cmd test`

Expected: all tests pass; rerun outside the sandbox if `MemoryService` hits its known user-directory `EPERM`.

- [x] **Step 2: Run typecheck and production build**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run build`

Expected: both pass with only pre-existing Vite dynamic/static import warnings.

- [x] **Step 3: Review the focused diff**

Run `git diff --check` on the prompt, subagent definition, and test files. Confirm tool lists, permissions, `Read` execution, and unrelated files are unchanged.
