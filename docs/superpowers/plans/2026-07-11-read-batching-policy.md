# Read Batching Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the model batch all currently known independent file and range reads into the fewest `Read.files` calls the schema permits instead of creating avoidable model loops.

**Architecture:** Strengthen the model-facing `ReadTool.description` with an explicit decision rule, then align the core Harness, ToolPolicy, and Investigation prompt modules around the fewest `Read.files` calls the schema permits. Tests assert both the tool description and the fully assembled system prompt so later prompt edits cannot silently restore singular or repetitive reading behavior.

**Tech Stack:** TypeScript, prompt modules, Vitest.

## Global Constraints

- Do not add runtime overlap blocking.
- Do not change the `Read` schema or execution implementation.
- Permit sequential reads only when the next target depends on the current result, the file changed, or context trimming removed the prior content.
- Merge known adjacent or overlapping ranges before calling `Read`.
- Use the fewest `Read.files` calls allowed by the existing schema; dispatch overflow batches in the same model response without adding or hardcoding a new limit.
- Do not modify historical design documents.
- Do not commit unless explicitly requested.

---

### Task 1: Lock the Batching Policy With Tests

**Files:**
- Modify: `src/tests/read-tool.test.ts`
- Modify: `src/tests/system-prompt-service.test.ts`

**Interfaces:**
- Consumes: `ReadTool.description`.
- Consumes: `SystemPromptService.buildSystemPrompt()`.
- Produces: regression assertions for known-target batching, range merging, and dependency exceptions.

- [x] **Step 1: Add failing Read description assertions**

Add a test requiring the description to contain these exact concepts:

```ts
expect(description).toContain('Before calling Read, collect every file and range already known')
expect(description).toContain('merge adjacent or overlapping ranges')
expect(description).toContain('only when the next target depends on the current result')
```

- [x] **Step 2: Add failing assembled-prompt assertions**

Add a test requiring the system prompt to contain:

```ts
expect(prompt).toContain('Batch known reads before calling tools')
expect(prompt).toContain('Read one or more known files or ranges')
expect(prompt).toContain('Plan reads, batch known targets, then edit')
expect(prompt).not.toContain('Read twice, edit once')
```

- [x] **Step 3: Run targeted tests and verify failure**

Run: `npm test -- src/tests/read-tool.test.ts src/tests/system-prompt-service.test.ts`

Expected: new policy assertions FAIL against the old descriptions.

---

### Task 2: Align Tool and System Prompt Rules

**Files:**
- Modify: `src/main/tools/builtin/ReadTool.ts`
- Modify: `src/main/services/prompts/core/Harness.ts`
- Modify: `src/main/services/prompts/execution/ToolPolicy.ts`
- Modify: `src/main/services/prompts/execution/Investigation.ts`

**Interfaces:**
- Produces: one consistent batching decision policy across tool and system descriptions.

- [x] **Step 1: Strengthen ReadTool.description**

Append concise rules stating:

```text
Before calling Read, collect every file and range already known. If two or more independent targets are known, put them in as few files arrays as the schema permits. When they exceed one array's capacity, issue the additional independent Read calls in the same response. For one file, merge adjacent or overlapping ranges instead of issuing sequential calls. Use a one-item array only when there is truly one target or when the next target depends on the current result. Re-read prior ranges only after a file change or context trimming.
```

- [x] **Step 2: Add the core Harness batching rule**

Add beside the parallel-call policy:

```text
- Batch known reads before calling tools: combine independent files and ranges into the fewest Read.files calls the schema permits; dispatch overflow batches in the same response instead of spreading them across model loops.
```

- [x] **Step 3: Update ToolPolicy vocabulary and exception**

Change the table row to:

```text
| Read one or more known files or ranges | Read with one files array |
```

Add a policy line that separates known independent reads from data-dependent reads.

- [x] **Step 4: Update Investigation sequencing**

Add target collection before reading, batch known target/neighbor/caller/callee/test reads, document the dependency exception, and replace the golden rule with:

```text
Plan reads, batch known targets, then edit.
```

- [x] **Step 5: Run targeted tests**

Run: `npm test -- src/tests/read-tool.test.ts src/tests/system-prompt-service.test.ts`

Expected: all targeted tests PASS.

---

### Task 3: Regression Verification

**Files:**
- Verify only.

**Interfaces:**
- Consumes: completed policy changes.
- Produces: verified prompt and build output.

- [x] **Step 1: Run full tests**

Run: `npm test`

Expected: all tests PASS.

- [x] **Step 2: Run typecheck and production build**

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run build`

Expected: PASS with only pre-existing Vite warnings.

- [x] **Step 3: Review focused diff**

Run: `git diff --check -- src/main/tools/builtin/ReadTool.ts src/main/services/prompts/core/Harness.ts src/main/services/prompts/execution/ToolPolicy.ts src/main/services/prompts/execution/Investigation.ts src/tests/read-tool.test.ts src/tests/system-prompt-service.test.ts`

Expected: no whitespace errors and no runtime Read implementation changes.
