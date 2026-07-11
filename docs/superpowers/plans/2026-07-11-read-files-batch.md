# Read Files Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-file `Read` input with a required 1–8 item `files` array and render multi-file calls as one expandable parallel-read card.

**Architecture:** `ReadTool.execute` validates the batch contract and delegates each item to one extracted single-file method through `Promise.all`, preserving all current read semantics. Existing runtime callers migrate to the new array shape, while the execution-log timeline expands one multi-file `Read` call into clickable child rows grouped by the existing parallel-card infrastructure.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Electron, React 18, Zustand, Vitest.

## Global Constraints

- `Read` accepts only `files`; top-level `file_path`, `offset`, `limit`, and `pages` are invalid.
- `files` requires 1–8 objects with `file_path` and optional per-file `offset`, `limit`, and `pages`.
- Do not add a batch-wide output limit.
- Keep all current single-file security, fingerprint, SHA, notebook, numbering, and truncation behavior.
- A per-file error must not fail other files.
- Do not read, reuse, or modify `ProjectAnalysisService.readManyFiles()`.
- Do not modify historical design documents.
- Do not commit unless the user explicitly requests it.

---

### Task 1: Replace Read Input With Files Array

**Files:**
- Modify: `src/main/tools/builtin/ReadTool.ts`
- Modify: `src/tests/read-tool.test.ts`

**Interfaces:**
- Produces: `ReadArgs { files: ReadFileArgs[] }`.
- Produces: `ReadFileArgs { file_path: string; offset?: number; limit?: number; pages?: string }`.
- Produces: `ReadTool.readOneFile(input, context): Promise<string>` as a private implementation detail.

- [ ] **Step 1: Rewrite tests for the breaking input contract**

Use the helper:

```ts
const readArgs = (...files: Array<{ file_path: string; offset?: number; limit?: number }>) =>
  JSON.stringify({ files })
```

Migrate all existing tests to `readArgs(...)`, then add tests that:

```ts
it('reads multiple files concurrently and preserves input order')
it('returns successful files when one file fails')
it('rejects an empty files array')
it('rejects more than eight files')
it('rejects the removed top-level file_path shape')
```

- [ ] **Step 2: Run Read tests and verify the new cases fail**

Run: `npm test -- src/tests/read-tool.test.ts`

Expected: migrated single-file tests fail until `ReadTool` accepts `files`; new validation and batch tests fail.

- [ ] **Step 3: Replace the schema**

Expose only:

```ts
{
  type: 'object',
  properties: {
    files: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          offset: { type: 'number' },
          limit: { type: 'number' },
          pages: { type: 'string' }
        },
        required: ['file_path'],
        additionalProperties: false
      }
    }
  },
  required: ['files'],
  additionalProperties: false
}
```

- [ ] **Step 4: Extract and parallelize the existing implementation**

Keep current read behavior inside:

```ts
private async readOneFile(parsed: ReadFileArgs, context: ToolContext): Promise<string>
```

Validate `files` before execution, run `Promise.all(parsed.files.map(...))`, and format each result as:

```ts
`<file path="${escapeAttribute(file.file_path)}">\n${result}\n</file>`
```

Use a small local attribute escaper for `&`, `"`, `<`, and `>` so paths cannot break the boundary markers.

- [ ] **Step 5: Run Read tests**

Run: `npm test -- src/tests/read-tool.test.ts`

Expected: all Read tests PASS.

---

### Task 2: Migrate Runtime Callers and Tracking

**Files:**
- Modify: `src/tests/edit-tool.test.ts`
- Modify: `src/tests/write-tool.test.ts`
- Modify: `src/tests/notebook-edit-tool.test.ts`
- Modify: `src/tests/subagent-permission-scope.test.ts`
- Modify: `src/main/agent/SubAgentManager.ts`
- Modify: `resources/builtin-skills/skill-creator/scripts/run_eval.py`

**Interfaces:**
- Consumes: `Read { files: ReadFileArgs[] }` from Task 1.
- Produces: subagent `filesExamined` tracking for every `files[].file_path`.

- [ ] **Step 1: Migrate direct ReadTool calls**

Replace each test setup call:

```ts
new ReadTool().execute(JSON.stringify({ file_path: fp }), context)
```

with:

```ts
new ReadTool().execute(JSON.stringify({ files: [{ file_path: fp }] }), context)
```

- [ ] **Step 2: Update subagent permission fixtures**

Use `{ files: [{ file_path: 'a.ts' }] }` for Read permission tests. The permission result remains read-only allowed; path enforcement remains inside `ReadTool`.

- [ ] **Step 3: Track every examined file**

Change the Read tracking block to:

```ts
if (name === 'Read') {
  const parsed = JSON.parse(args)
  for (const file of parsed.files || []) {
    if (file?.file_path) filesExamined.add(file.file_path)
  }
}
```

Keep `list_files` tracking behavior unchanged.

- [ ] **Step 4: Update skill evaluation input inspection**

When inspecting a `Read` tool call, mark a file as triggered if `clean_name` appears in any `tool_input.files[].file_path`.

- [ ] **Step 5: Run affected tests**

Run: `npm test -- src/tests/edit-tool.test.ts src/tests/write-tool.test.ts src/tests/notebook-edit-tool.test.ts src/tests/subagent-permission-scope.test.ts`

Expected: all selected tests PASS.

---

### Task 3: Render Multi-File Read Cards

**Files:**
- Modify: `src/renderer/src/components/chat/ExecutionLog/utils/types.ts`
- Modify: `src/renderer/src/components/chat/ExecutionLog/utils/timelineBuilder.ts`
- Modify: `src/renderer/src/components/chat/ExecutionLog/utils/batchBuilder.ts`
- Modify: `src/renderer/src/components/chat/ExecutionLog/components/ParallelToolBatchCard.tsx`
- Modify: `src/tests/execution-log-batch-builder.test.ts`

**Interfaces:**
- Produces: optional `batchKind?: 'tools' | 'read'` on unified and grouped timeline items.
- Consumes: `Read` arguments with `files`.
- Produces: “正在并行读取 N 个文件” and “并行读取 N 个文件” card titles.

- [ ] **Step 1: Add failing renderer utility tests**

Add tests that verify:

```ts
it('uses visible child count for expanded batches')
it('preserves the read batch kind')
```

- [ ] **Step 2: Run the targeted renderer test and verify failure**

Run: `npm test -- src/tests/execution-log-batch-builder.test.ts`

Expected: FAIL until batch kind and visible child count are implemented.

- [ ] **Step 3: Expand Read files into child timeline items**

In the `tc.name === 'Read'` branch, parse `args.files`. For one item, emit the existing single file row. For multiple items, emit one row per file with:

```ts
batchId: tc.batchId ?? `read_batch_${tc.id}`
batchIndex: tc.batchIndex ?? index
batchSize: tc.batchId ? tc.batchSize : files.length
batchKind: tc.batchId ? 'tools' : 'read'
```

Each child keeps `realPath`, `fileName`, range text, tool timing, and click behavior.

- [ ] **Step 4: Preserve kind and count rendered children**

Add `batchKind` to the timeline types. In `groupParallelToolBatches`, set `batchSize: batchItems.length` and carry the first item’s `batchKind ?? 'tools'`.

- [ ] **Step 5: Update card title copy**

Use:

```ts
const title = batch.batchKind === 'read'
  ? batch.status === 'running'
    ? `正在并行读取 ${batch.batchSize} 个文件`
    : `并行读取 ${batch.batchSize} 个文件`
  : batch.status === 'running'
    ? `正在并行执行 ${batch.batchSize} 项`
    : `并行执行 ${batch.batchSize} 项`
```

- [ ] **Step 6: Run renderer tests and typecheck**

Run: `npm test -- src/tests/execution-log-batch-builder.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

---

### Task 4: Full Regression Verification

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: verified breaking migration with no remaining active `Read` callers using top-level `file_path`.

- [ ] **Step 1: Search active code for removed Read calls**

Run: `rg -n "new ReadTool\\(\\).*file_path|checkSubAgentToolPermission\\('Read', \\{ file_path|tool_name == \\"Read\\".*file_path" src resources`

Expected: no active runtime or test call remains on the removed shape.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 3: Run typecheck and production build**

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run build`

Expected: PASS with only pre-existing Vite warnings.

- [ ] **Step 4: Review the focused diff**

Run: `git diff --check -- src/main/tools/builtin/ReadTool.ts src/main/agent/SubAgentManager.ts src/renderer/src/components/chat/ExecutionLog src/tests/read-tool.test.ts src/tests/edit-tool.test.ts src/tests/write-tool.test.ts src/tests/notebook-edit-tool.test.ts src/tests/subagent-permission-scope.test.ts resources/builtin-skills/skill-creator/scripts/run_eval.py`

Expected: no whitespace errors and every changed line maps to the new Read contract or log presentation.
