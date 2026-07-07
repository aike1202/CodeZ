# Task Capsule Theme Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Task capsule and expanded card use existing app theme colors in light and dark mode.

**Architecture:** Keep `TaskCapsule.tsx` unchanged and treat the CSS file as the component styling boundary. Add a focused Vitest contract test that reads the CSS and prevents accidental reintroduction of missing fallback theme tokens.

**Tech Stack:** React 18, Electron Vite, CSS custom properties, Vitest.

## Global Constraints

- Preserve the current Task capsule layout, positioning, and interaction behavior.
- Do not touch unrelated dirty worktree files.
- Use explicit UTF-8 when reading or writing files in PowerShell.

---

### Task 1: Add CSS Theme Contract Test

**Files:**
- Create: `src/tests/task-capsule-theme-colors.test.ts`

**Interfaces:**
- Consumes: `src/renderer/src/components/chat/TaskCapsule.css`
- Produces: Vitest assertions for Task capsule theme token usage.

- [ ] **Step 1: Write the failing test**

```typescript
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/chat/TaskCapsule.css'), 'utf8')

describe('TaskCapsule theme colors', () => {
  it('uses app theme tokens for surfaces and text instead of missing light fallbacks', () => {
    expect(css).toContain('background: var(--bg-panel);')
    expect(css).toContain('color: var(--text-main);')
    expect(css).toContain('color: var(--text-muted);')
    expect(css).toContain('color: var(--text-light);')
    expect(css).not.toContain('--surface-elevated')
    expect(css).not.toContain('--text-primary')
    expect(css).not.toContain('--text-secondary')
    expect(css).not.toContain('--text-tertiary')
  })

  it('keeps dark floating-card depth inside the dark theme', () => {
    expect(css).toContain('.dark .task-capsule-wrapper .plan-capsule')
    expect(css).toContain('.dark .task-capsule-wrapper .plan-capsule-popover')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/tests/task-capsule-theme-colors.test.ts`

Expected: FAIL because the CSS still contains `--surface-elevated`, `--text-primary`, `--text-secondary`, and `--text-tertiary`.

### Task 2: Update TaskCapsule CSS Tokens

**Files:**
- Modify: `src/renderer/src/components/chat/TaskCapsule.css`

**Interfaces:**
- Consumes: global theme tokens from `src/renderer/src/styles.css`
- Produces: theme-aligned Task capsule and popover styling.

- [ ] **Step 1: Replace missing component tokens**

Use `--bg-panel`, `--text-main`, `--text-muted`, `--text-light`, `--primary-color`, and `--border-color` in the Task capsule CSS.

- [ ] **Step 2: Add dark shadow overrides**

Add selectors for `.dark .task-capsule-wrapper .plan-capsule` and `.dark .task-capsule-wrapper .plan-capsule-popover` so dark mode keeps subtle depth.

- [ ] **Step 3: Run the focused test**

Run: `npm test -- src/tests/task-capsule-theme-colors.test.ts`

Expected: PASS.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

## Self Review

- Spec coverage: both acceptance criteria and dark-mode depth are covered by the tasks.
- Placeholder scan: no placeholder language remains.
- Type consistency: the plan only references existing CSS classes and global theme tokens.
