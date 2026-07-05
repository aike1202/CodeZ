---
name: subagent-io-design
description: "Specification for SubAgent input/output design — structured tasking, output schemas, quality validation, and the delegation guidance system prompt section."
metadata:
  type: project
---

# SubAgent I/O Design — Structured Delegation & Quality Assurance

**Date:** 2026-07-05
**Status:** Design (pending approval)
**Scope:** Redesign SubAgent input (`SubAgentContext`) and output (`SubAgentResult`) to close the information-loss gap inherent in delegation, plus a system prompt section that teaches the main Agent when and how to delegate.

## Motivation

### Current State

The SubAgent framework (`SubAgentManager.ts`) works but delegates with minimal structure:

```
Main Agent                              Research SubAgent
  │                                         │
  │ Task({ subagent_type: "Research",       │
  │       prompt: "探索路由结构" })           │
  ├────────────────────────────────────────→│
  │                                         │ ctx.parentPrompt = "探索路由结构"
  │                                         │ ctx.parentMessages = undefined (declared but unused)
  │                                         │ messages = [system, user:prompt]
  │                                         │ ← plain text output
  │ ← { ok, data: { output: "结论是...",     │
  │       toolCallCount: 8 } }               │
  │                                         │
  │ Main Agent parses text, may miss things  │
```

### Problems

| # | Problem | Impact |
|---|---------|--------|
| 1 | **Input is a bare prompt string** — no acceptance criteria, no known context, no scope boundaries | SubAgent may answer the wrong question or re-search already-known files |
| 2 | **Output is unstructured text** — Main Agent must NLP-parse findings | Key findings get lost; evidence references are embedded in prose |
| 3 | **No quality signal** — Main Agent has no way to know if the SubAgent did a thorough job or a sloppy one | Main Agent either blindly trusts or wastes time double-checking |
| 4 | **No "what I didn't find" channel** — SubAgent silently omits things it couldn't resolve | Silent information loss |
| 5 | **No delegation guidance in system prompt** — Main Agent doesn't know when to use Task tool vs. search directly | Main Agent keeps doing multi-file exploration itself |

### Design Principles

1. **Intent over Instruction** — Main Agent says *what it needs to know*, not *how to search*. SubAgent retains autonomy over exploration strategy.
2. **Evidence-anchored Output** — Every finding must be traceable to a `file:line`. No free-floating claims.
3. **Degradable Gracefully** — Structured output is preferred but plain text must still work as a fallback (provider compatibility).
4. **Zero-config Extension** — Adding a new SubAgent type = one definition file + one registration line. Framework auto-generates tool schemas, system prompt sections, and validation.
5. **Coverage over Completeness** — The framework doesn't guarantee 100% information transfer (impossible), but gives the Main Agent a **quality signal** to decide trust level.

---

## 1. Input Design: `SubAgentContext`

### Full Interface

```typescript
export interface SubAgentContext {
  // ═══ Required ═══
  workspaceRoot: string
  sessionId: string
  /** One-sentence description of the problem to solve */
  task: string

  // ═══ Acceptance Criteria (NEW — critical!) ═══
  /**
   * What the Main Agent needs to know.
   * Injected into SubAgent's system prompt as a self-check checklist.
   * The SubAgent MUST address every question before calling submit_result.
   */
  expectations: {
    /** Specific questions that must be answered */
    questions: string[]
    /** Explicitly out of scope — don't waste tool calls on these */
    outOfScope?: string[]
  }

  // ═══ Optional Context ═══
  /**
   * What the Main Agent already knows about the problem domain.
   * Natural language, NOT a structured file list.
   * This is INFORMATION, not INSTRUCTION — the SubAgent can disagree or revise.
   *
   * Example:
   * "We're debugging an auth middleware issue. Token storage layer looks fine
   *  (read src/auth/AuthService.ts:120-180). Need to trace how the middleware
   *  chain validates tokens and what error codes surface to the client."
   */
  context?: string

  // ═══ Structural Constraints ═══
  /**
   * Domain boundaries — structural facts, not exploration hints.
   * Use for monorepo scoping or to exclude generated/vendor code.
   */
  scope?: {
    /** Limit to these directories (relative to workspaceRoot) */
    directories?: string[]
    /** Glob patterns to exclude (e.g., '**\/*.test.ts', '**\/generated\/**') */
    excludeGlobs?: string[]
  }

  // ═══ Depth Control ═══
  /**
   * Exploration depth → framework maps to maxLoops.
   *   quick:       6 loops  — locate a symbol/answer a yes-no question
   *   normal:     12 loops  — trace a medium-complexity data flow
   *   exhaustive: 20 loops  — full module audit
   */
  depth?: 'quick' | 'normal' | 'exhaustive'

  // ═══ Framework Configuration ═══
  modelOverride?: string
  maxLoopsOverride?: number
  parentMessages?: ChatMessage[]
  apiConfig: {
    baseUrl: string
    apiKey: string
    apiFormat: string
    model: string
    thinking?: boolean
  }
}
```

### Depth → maxLoops Mapping

```typescript
const DEPTH_LOOPS: Record<string, number> = {
  quick: 6,
  normal: 12,
  exhaustive: 20,
}

// Resolution order: maxLoopsOverride > depth mapping > definition default
function resolveMaxLoops(def: SubAgentDefinition, ctx: SubAgentContext): number {
  if (ctx.maxLoopsOverride) return ctx.maxLoopsOverride
  if (ctx.depth) return DEPTH_LOOPS[ctx.depth] ?? def.maxLoops
  return def.maxLoops
}
```

### Why `context` is Natural Language, Not a File List

| Approach | Problem |
|----------|---------|
| `knownFiles: ["src/auth/AuthService.ts"]` | Implies "trust me, this is correct." If wrong, SubAgent never discovers. |
| `excludePaths: ["src/tests/"]` | Implies "nothing relevant here." If wrong, SubAgent misses critical info. |
| Natural language: "I read AuthService.ts:120-180 and the token storage logic looks correct." | SubAgent knows what was observed but can say "Actually, line 185 has a subtle issue..." |

Bottom line: **`scope` is structural boundary; `context` is fallible information.** The SubAgent can challenge information but must respect boundaries.

---

## 2. Output Design: `SubAgentResult`

### Core Problem

Pure text output from SubAgent → Main Agent has ~20% information fidelity. We need:
- **Structure** so Main Agent can consume findings programmatically
- **Evidence** so Main Agent can spot-check without re-researching
- **Confidence** so Main Agent knows what to trust vs. verify
- **Unresolved declaration** so silence ≠ omission

### Full Interface

```typescript
export interface SubAgentResult {
  type: string
  /** Raw text output — always present as fallback */
  output: string
  /** Structured findings — present if SubAgent used submit_result tool */
  structuredOutput?: SubAgentStructuredOutput
  /** Quality metadata computed by the framework post-execution */
  qualitySummary?: SubAgentQualitySummary
  toolCallCount: number
  /** Files actually read during exploration (for audit trail) */
  filesExamined?: string[]
  planSlug?: string
}

export interface SubAgentStructuredOutput {
  /** One-sentence conclusion answering the original task */
  conclusion: string
  /** Per-question answers mapping to expectations.questions */
  answers: SubAgentAnswer[]
  /** Questions that could not be answered + reasons */
  unresolved: SubAgentUnresolved[]
  /** Discoveries the SubAgent made beyond what was asked */
  additionalDiscoveries?: SubAgentAnswer[]
}

export interface SubAgentAnswer {
  /** Which question this answers */
  question: string
  /** The answer */
  answer: string
  /** Confidence level */
  confidence: 'confirmed' | 'likely' | 'speculative'
  /** Evidence anchors for spot-checking */
  evidence: SubAgentEvidence[]
}

export interface SubAgentEvidence {
  /** File path relative to workspaceRoot */
  file: string
  /** Line number */
  line: number
  /** Short code snippet or description (≤200 chars) */
  snippet: string
}

export interface SubAgentUnresolved {
  question: string
  reason: string
}

export interface SubAgentQualitySummary {
  /** Fraction of expectations.questions that got answered */
  coverage: number          // 0.0 – 1.0
  /** Fraction of answers with confidence: 'confirmed' */
  confirmedRatio: number    // 0.0 – 1.0
  /** Number of unresolved questions */
  unresolvedCount: number
  /** Warning message if quality is below threshold, null otherwise */
  warning: string | null
}
```

### Confidence Levels

| Level | Meaning | Main Agent Action |
|-------|---------|-------------------|
| `confirmed` | Read the source code, exact file:line evidence | Trust; spot-check at most 1-2 findings |
| `likely` | Strong indirect evidence or inference | Read the cited evidence files to confirm |
| `speculative` | Reasonable guess, not confirmed by code | Treat as hypothesis; verify before acting |

### Quality Summary Generation (in `onAfterComplete`)

```typescript
function computeQualitySummary(
  expectations: SubAgentContext['expectations'],
  structured: SubAgentStructuredOutput | undefined,
  unresolved: SubAgentUnresolved[]
): SubAgentQualitySummary {
  const expectedCount = expectations?.questions?.length ?? 0
  if (expectedCount === 0 || !structured) {
    return {
      coverage: structured ? 1 : 0,
      confirmedRatio: 0,
      unresolvedCount: unresolved.length,
      warning: !structured ? 'SubAgent did not produce structured output' : null
    }
  }

  const answeredCount = structured.answers.length
  const confirmedCount = structured.answers.filter(a => a.confidence === 'confirmed').length
  const coverage = answeredCount / expectedCount
  const confirmedRatio = answeredCount > 0 ? confirmedCount / answeredCount : 0

  let warning: string | null = null
  if (coverage < 0.5) {
    warning = `Only ${Math.round(coverage * 100)}% of questions were answered (${answeredCount}/${expectedCount}). Consider re-delegating or investigating directly.`
  } else if (confirmedRatio < 0.3) {
    warning = `Only ${Math.round(confirmedRatio * 100)}% of answers are confirmed. Most findings need verification.`
  }

  return { coverage, confirmedRatio, unresolvedCount: unresolved.length, warning }
}
```

### How Main Agent Consumes the Result

Given a tool result like:

```json
{
  "ok": true,
  "data": {
    "structuredOutput": {
      "conclusion": "Auth middleware chain: TokenFilter → SessionFilter → RoleFilter. Token failures return 401 before reaching RoleFilter.",
      "answers": [
        {
          "question": "What is the middleware call chain?",
          "answer": "TokenFilter (src/auth/TokenFilter.ts:34) → SessionFilter (src/auth/SessionFilter.ts:22) → RoleFilter (src/auth/RoleFilter.ts:15). Filters check for a jwtToken cookie in request header.",
          "confidence": "confirmed",
          "evidence": [
            { "file": "src/auth/TokenFilter.ts", "line": 34, "snippet": "public async filter(ctx: Context, next: () => Promise<void>): Promise<void> { const token = ..." },
            { "file": "src/auth/SessionFilter.ts", "line": 22, "snippet": "if (!ctx.state.session) throw new UnauthorizedError()" }
          ]
        }
      ],
      "unresolved": [],
      "additionalDiscoveries": [
        {
          "question": "What happens when TokenFilter throws vs. returns 401?",
          "answer": "The global error handler in src/middleware/ErrorHandler.ts:45 catches all filter exceptions and maps them to HTTP responses.",
          "confidence": "likely",
          "evidence": [{ "file": "src/middleware/ErrorHandler.ts", "line": 45, "snippet": "if (err instanceof UnauthorizedError) ctx.status = 401" }]
        }
      ]
    },
    "qualitySummary": {
      "coverage": 1.0,
      "confirmedRatio": 0.67,
      "unresolvedCount": 0,
      "warning": null
    },
    "toolCallCount": 7,
    "filesExamined": ["src/auth/TokenFilter.ts", "src/auth/SessionFilter.ts", "src/auth/RoleFilter.ts", "src/middleware/ErrorHandler.ts"]
  }
}
```

Main Agent reads:
- `qualitySummary.coverage === 1.0` → all questions answered
- `qualitySummary.confirmedRatio === 0.67` → mostly solid, one answer less certain
- `additionalDiscoveries` → found something I didn't ask about, worth checking
- Decision: **trust the confirmed answers, spot-check the likely one**

---

## 3. Output Specification: Per-Agent Type Schemas

Each SubAgent type declares its output shape. The framework auto-generates a `submit_result` tool and injects it into the SubAgent's tool set.

### Declaration in `SubAgentDefinition`

```typescript
export interface SubAgentDefinition {
  type: string
  description: string

  // ═══ Delegation Guidance (for system prompt section) ═══
  whenToUse: string          // When the Main Agent should delegate
  whenNotToUse?: string      // Anti-patterns to avoid
  costHint?: string          // Token/cost expectations

  // ═══ Execution ═══
  systemPromptBuilder: (ctx: SubAgentContext) => string
  getTools(toolManager: ToolManager): ToolDefinition[]
  maxLoops: number

  // ═══ Output ═══
  /**
   * Structured output specification.
   * When set, framework injects a submit_result tool with JSON Schema matching these fields.
   * When unset, SubAgent returns plain text (backward compatible).
   */
  outputSpec?: SubAgentOutputSpec

  // ═══ Configuration ═══
  defaultModel?: string
  isolation?: 'none' | 'worktree'
  canRunInBackground?: boolean
  onBeforeSpawn?: (ctx: SubAgentContext) => Promise<void>
  onAfterComplete?: (ctx: SubAgentContext, result: SubAgentResult) => Promise<void>
}

export interface SubAgentOutputSpec {
  /** Description for the submit_result tool */
  description: string
  /** Output fields */
  fields: SubAgentOutputField[]
}

export interface SubAgentOutputField {
  name: string
  type: 'string' | 'string[]' | 'number' | 'boolean'
  description: string
  required: boolean
}
```

### Research SubAgent OutputSpec

```typescript
const ResearchOutputSpec: SubAgentOutputSpec = {
  description: 'Submit your research findings as structured data. Call this when you have answered all questions in your acceptance criteria.',
  fields: [
    { name: 'conclusion', type: 'string', description: 'One-sentence conclusion answering the research task', required: true },
    { name: 'answers', type: 'string[]', description: 'Per-question answers with confidence level and file:line evidence', required: true },
    { name: 'unresolved', type: 'string[]', description: 'Questions that could not be answered, with reasons', required: true },
    { name: 'additionalDiscoveries', type: 'string[]', description: 'Important findings beyond what was explicitly asked', required: false },
  ]
}
```

### Framework Auto-Generation

In `SubAgentManager.spawn()`:

1. Read `def.outputSpec`
2. If present, generate a `submit_result` tool definition:

```typescript
function generateSubmitResultTool(spec: SubAgentOutputSpec): ToolDefinition {
  const properties: Record<string, any> = {}
  const required: string[] = []

  for (const field of spec.fields) {
    properties[field.name] = {
      type: field.type === 'string[]' ? 'array' : field.type,
      description: field.description,
      ...(field.type === 'string[]' ? { items: { type: 'string' } } : {})
    }
    if (field.required) required.push(field.name)
  }

  return {
    type: 'function',
    function: {
      name: 'submit_result',
      description: spec.description,
      parameters: {
        type: 'object',
        properties,
        required
      }
    }
  }
}
```

3. Append to SubAgent's system prompt:

```
## Output Requirements
When you have completed your research, call submit_result with your findings.
Do NOT output your final answer as plain text — use the tool.
If you produce plain text instead, your results will NOT be parsed correctly
and important findings may be lost.
```

4. In the termination logic of `spawn()`, handle both paths:

```typescript
if (toolCallsArray.length === 0) {
  // Plain-text fallback
  finalOutput = currentContent
  if (def.outputSpec) {
    // Best-effort JSON extraction from text
    const maybeJson = extractJsonBlock(currentContent)
    if (maybeJson) {
      subResult.structuredOutput = validateAgainstSpec(maybeJson, def.outputSpec)
    }
  }
  // Compute quality summary regardless
  if (subResult.structuredOutput) {
    subResult.qualitySummary = computeQualitySummary(ctx, subResult.structuredOutput)
  }
  break
}
```

---

## 4. Proactive Discovery

Even with explicit `expectations.questions`, the Main Agent can't ask about what it doesn't know exists. The SubAgent needs permission to surface things beyond the checklist.

### Injected into SubAgent's System Prompt

```
## Proactive Discovery
1. After your initial exploration (first 2-3 tool calls), pause and review.
2. Ask yourself: "Based on what I've seen so far, is there a critical question
   the caller SHOULD have asked but didn't?"
3. If yes, explore and answer it. Flag these as "additionalDiscoveries" in your
   submit_result call — keep them separate from the original questions.
```

### Different from "Going Off-Track"

Proactive discovery is bounded:
- It fires after **2-3 tool calls** (not immediately) — the SubAgent has context first
- It produces `additionalDiscoveries` — clearly labeled as supplementary
- It does NOT override the acceptance criteria — the original questions still come first
- If a proactive line would consume >3 additional rounds, the SubAgent abandons it and notes it in `unresolved`

---

## 5. System Prompt Integration: Delegation Guidance Section

### New Section File

`src/main/services/prompts/sections/SubAgents.ts`

```typescript
import { SubAgentManager } from '../../../agent/SubAgentManager'

export function buildSubAgentGuidance(): string {
  const defs = SubAgentManager.listDefinitions()
  if (defs.length === 0) return ''

  const lines: string[] = []
  lines.push('<delegation_guidance>')
  lines.push('## When to Delegate to SubAgents via the Task Tool')
  lines.push('')
  lines.push('Delegating complex work to specialized SubAgents is MORE EFFICIENT than doing everything yourself because each SubAgent has:')
  lines.push('- An isolated context window (does not consume your token budget)')
  lines.push('- A focused tool set optimized for its task')
  lines.push('- A structured output format with evidence anchors and quality metadata')
  lines.push('')

  // Decision framework table
  lines.push('### Quick Decision Table')
  lines.push('| Situation | Action |')
  lines.push('|-----------|--------|')
  lines.push('| Single file/symbol lookup | Use Glob/Grep/Read directly |')
  lines.push('| Cross-cutting exploration (3+ files/directories) | Delegate to Research |')
  lines.push('| Multi-step implementation plan needed | Use EnterPlanMode (→ Plan SubAgent) |')
  lines.push('| Two fully independent explorations | Run two SubAgents in parallel |')
  lines.push('| Answer is in your conversation context | Do NOT delegate — use what you already have |')
  lines.push('')

  // Per-type guidance
  for (const d of defs) {
    lines.push(`### ${d.type} SubAgent`)
    lines.push(`**Purpose:** ${d.description}`)
    lines.push('')
    lines.push('**Use when:**')
    for (const line of d.whenToUse.split('\n').filter(Boolean)) {
      lines.push(`- ${line.trim()}`)
    }
    if (d.whenNotToUse) {
      lines.push('')
      lines.push('**Do NOT use when:**')
      for (const line of d.whenNotToUse.split('\n').filter(Boolean)) {
        lines.push(`- ${line.trim()}`)
      }
    }
    if (d.costHint) {
      lines.push('')
      lines.push(`**Cost:** ${d.costHint}`)
    }
    lines.push('')
  }

  // General guidance
  lines.push('### How to Write a Good Task Prompt')
  lines.push('1. **State the core question** — one sentence describing what you need to know.')
  lines.push('2. **Include acceptance criteria** — use `expectations.questions` to list specific sub-questions.')
  lines.push('3. **Provide known context** — use the `context` field to tell the SubAgent what you already know.')
  lines.push('4. **Set explicit scope** — use `expectations.outOfScope` to declare what NOT to investigate.')
  lines.push('5. **Choose the right depth** — `quick` for yes/no, `normal` for tracing, `exhaustive` for audits.')
  lines.push('')
  lines.push('### How to Read Results')
  lines.push('- Check `qualitySummary.coverage` — below 0.5 means re-delegate or investigate yourself.')
  lines.push('- Check `qualitySummary.confirmedRatio` — below 0.3 means most findings need verification.')
  lines.push('- Read `unresolved` first — these are the known unknowns.')
  lines.push('- Trust `confirmed` answers; spot-check `likely` answers; verify `speculative` ones.')
  lines.push('')
  lines.push('**Important:** Delegating is cheaper than doing it yourself. If unsure, delegate — the SubAgent returns structured evidence you can act on immediately.')
  lines.push('</delegation_guidance>')
  return lines.join('\n')
}
```

### Injection Point

In `assembleSystemPrompt()` (`prompts/index.ts`), insert between `buildGitStatus` and `buildAvailableTools`:

```typescript
sections.push(buildSubAgentGuidance())   // ← NEW: delegation decision framework
sections.push(buildAvailableTools())     // tool list immediately follows
```

The placement is deliberate: the Agent sees delegation guidance, then the Task tool in the tool list — forming a "why → how" progression.

---

## 6. Extension Pattern: Adding a New SubAgent

Adding `CodeReviewAgent` as an example:

### Step 1: Definition File

```typescript
// src/main/agent/definitions/CodeReviewAgent.ts
export const CodeReviewAgent: SubAgentDefinition = {
  type: 'CodeReview',
  description: 'Reviews code changes for bugs, security issues, and style violations.',
  whenToUse: [
    'There is a git diff that needs thorough review.',
    'You want adversarial verification of a change before committing.',
    'The user explicitly asks for a code review.',
  ].join('\n'),
  whenNotToUse: [
    'The diff is a single-line typo fix.',
    'The same change was already reviewed in this session.',
  ].join('\n'),
  costHint: 'Up to 10 tool calls. Good for focused diff review; use direct Read for single-file checks.',
  maxLoops: 10,
  canRunInBackground: true,

  outputSpec: {
    description: 'Submit code review findings.',
    fields: [
      { name: 'verdict', type: 'string', description: 'APPROVED or CHANGES_REQUESTED', required: true },
      { name: 'severity', type: 'string', description: 'critical, major, minor, or none', required: true },
      { name: 'issues', type: 'string[]', description: 'Issues found with severity, file:line, and description', required: true },
      { name: 'suggestions', type: 'string[]', description: 'Improvement suggestions (non-blocking)', required: false },
    ]
  },

  systemPromptBuilder: (ctx) => `...`,
  getTools: (tm) => [...tm.getReadOnlyTools(), /* + diff tools if available */],
}
```

### Step 2: Register

```typescript
// src/main/agent/definitions/index.ts
export const allSubAgentDefinitions = [
  PlanSubAgent,
  ResearchSubAgent,
  CodeReviewAgent,  // ← one line
]
```

### What Happens Automatically

| Mechanism | Auto-Generated From |
|-----------|---------------------|
| Task tool `subagent_type` enum | `SubAgentManager.listDefinitions()` |
| System prompt delegation section | `definition.whenToUse` + `whenNotToUse` + `costHint` |
| `submit_result` tool JSON Schema | `definition.outputSpec` |
| Self-check checklist in SubAgent prompt | `ctx.expectations.questions` |
| Quality summary computation | `onAfterComplete` → `computeQualitySummary()` |
| Depth → maxLoops mapping | `ctx.depth` → `DEPTH_LOOPS` table |

---

## 7. Implementation Phases

### Phase 1: Interface Changes (no behavior change)

1. Extend `SubAgentDefinition` with `whenToUse`, `whenNotToUse`, `costHint`, `outputSpec`
2. Extend `SubAgentContext` with `task`, `expectations`, `context`, `scope`, `depth`
3. Extend `SubAgentResult` with `structuredOutput`, `qualitySummary`, `filesExamined`
4. Update `ResearchSubAgent` definition with new fields
5. Update `PlanSubAgent` definition with new fields

### Phase 2: Framework Logic

1. Implement `resolveMaxLoops()` in `SubAgentManager.spawn()`
2. Implement `generateSubmitResultTool()` 
3. Implement `extractJsonBlock()` for plain-text fallback
4. Implement `validateAgainstSpec()` 
5. Implement `computeQualitySummary()` in `onAfterComplete`
6. Inject self-check checklist + proactive discovery prompts into `systemPromptBuilder` output

### Phase 3: System Prompt Integration

1. Create `src/main/services/prompts/sections/SubAgents.ts`
2. Add to `assembleSystemPrompt()` in correct position
3. Update `TaskTool.description` to reference the delegation guidance section

### Phase 4: Research SubAgent Specifics

1. Add `ResearchOutputSpec` to `ResearchSubAgent`
2. Update Research system prompt template to include:
   - Acceptance criteria checklist
   - Proactive discovery trigger
   - `submit_result` usage instruction

---

## 8. Backward Compatibility

- `SubAgentContext.parentPrompt` → renamed to `task`, but `parentPrompt` kept as deprecated alias for one release
- `SubAgentResult.output` → kept as string; `structuredOutput` is an optional additional field
- SubAgents without `outputSpec` → no `submit_result` tool injected; plain-text output unchanged
- Existing `PlanSubAgent` → continues to work via `ExitPlanModeTool`; optionally adopts `outputSpec` later
- `parentMessages` → kept but documented as "only for SubAgents that need full conversation history"

---

## 9. Open Questions

1. **Should `submit_result` be a tool at the SubAgent level or a framework-enforced exit condition?**  
   Current design: tool at SubAgent level. Alternative: framework forces the last assistant message through a schema validation pass and retries on failure. Trade-off: tool approach works with any provider; retry approach requires provider support for response_format.
   
   **Decision needed:** Start with tool approach; add retry as enhancement if provider support is confirmed.

2. **Should `filesExamined` be auto-tracked by the framework or declared by the SubAgent?**  
   Framework can track every `Read` tool call. But that includes "Read 5 lines for a signature" noise. SubAgent declaration is more curated but relies on SubAgent honesty.
   
   **Decision needed:** Start with auto-tracked; let SubAgent curate `evidence` separately.

3. **`additionalDiscoveries` — same schema as `answers` or flat strings?**  
   Same schema gives richer data; flat strings are simpler. Balance: if we use same schema, `additionalDiscoveries` can feed into a follow-up delegation naturally.
   
   **Decision:** Same schema as `answers` (each entry has question, answer, confidence, evidence).
