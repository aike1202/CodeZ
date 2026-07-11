# Skill Invocation Detail Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw skill invocation detail block with a readable, branded card that structures arguments and renders skill output as Markdown.

**Architecture:** Keep timeline parsing unchanged and add a dedicated `Skill` / `invoke_skill` rendering branch inside `ExecutionLogDetail`. Reuse the existing lazy Markdown renderer, and add skill-specific classes so the generic tool, terminal, search, and task detail views retain their current behavior.

**Tech Stack:** React 18, TypeScript, CSS nesting, react-markdown, remark-gfm, Lucide-compatible SVG icons

## Global Constraints

- Preserve the existing light and dark theme variables.
- Do not add runtime dependencies.
- Keep all non-skill execution detail branches behaviorally unchanged.
- Use existing sans and monospace font tokens.
- Respect narrow chat panes and reduced-motion preferences.

---

### Task 1: Skill Timeline Identity

**Files:**
- Modify: `src/renderer/src/components/chat/ExecutionLog/components/LogItemRow.tsx`
- Modify: `src/renderer/src/components/chat/ExecutionLog/components/LogItemRow.css`

**Interfaces:**
- Consumes: `UnifiedTimelineItem.toolName`, `UnifiedTimelineItem.verb`, and the existing `IconSkills` component.
- Produces: `isSkillItem: boolean` and the `timeline-icon-skill` / `timeline-target-skill` visual hooks.

- [ ] **Step 1: Identify skill timeline rows**

```tsx
const isSkillItem =
  item.type === 'tool' && (item.toolName === 'Skill' || item.toolName === 'invoke_skill')
```

- [ ] **Step 2: Render the dedicated skill icon and target treatment**

```tsx
if (isSkillItem) return <IconSkills />

<span className={`timeline-icon-box${isSkillItem ? ' timeline-icon-skill' : ''}`}>
  {getItemIcon(item)}
</span>
<span className={`timeline-target-text${isSkillItem ? ' timeline-target-skill' : ''}`}>
  {item.target}
</span>
```

- [ ] **Step 3: Add focused row styling**

```css
.timeline-icon-skill {
  color: #7c5cff;
  background: rgba(124, 92, 255, 0.1);
  border-radius: 5px;
}

.timeline-target-skill {
  color: #6d4ce8;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}
```

- [ ] **Step 4: Run the renderer typecheck**

Run: `npm run typecheck`

Expected: exit code `0` with no TypeScript errors.

- [ ] **Step 5: Commit when requested by the repository owner**

```bash
git add src/renderer/src/components/chat/ExecutionLog/components/LogItemRow.tsx src/renderer/src/components/chat/ExecutionLog/components/LogItemRow.css
git commit -m "style: refine skill timeline identity"
```

### Task 2: Structured Skill Detail Card

**Files:**
- Modify: `src/renderer/src/components/chat/ExecutionLogDetail/index.tsx`
- Modify: `src/renderer/src/components/chat/ExecutionLogDetail/ExecutionLogDetail.css`

**Interfaces:**
- Consumes: parsed skill arguments shaped as `{ skill?: string, args?: unknown }` and `item.detail` Markdown.
- Produces: `SkillValue`, a recursive visual formatter for primitive, array, and object argument values; a dedicated skill detail card.

- [ ] **Step 1: Add the recursive value formatter**

```tsx
function SkillValue({ value }: { value: unknown }): React.ReactElement {
  if (Array.isArray(value)) {
    return <div className="exe-log-skill-token-list">{value.map((entry, entryIndex) => <span key={entryIndex} className="exe-log-skill-token">{String(entry)}</span>)}</div>
  }
  if (value && typeof value === 'object') {
    return <div className="exe-log-skill-object">{Object.entries(value).map(([key, entryValue]) => <div key={key} className="exe-log-skill-object-row"><span>{key}</span><SkillValue value={entryValue} /></div>)}</div>
  }
  return <span className="exe-log-skill-primitive">{String(value ?? '—')}</span>
}
```

- [ ] **Step 2: Add the dedicated skill branch before generic tool rendering**

```tsx
if (item.toolName === 'Skill' || item.toolName === 'invoke_skill') {
  const skillArgs = parseArgs(item.args || '')
  const skillName = String(skillArgs.skill || item.target || 'Skill')
  const invocationArgs = skillArgs.args ?? Object.fromEntries(Object.entries(skillArgs).filter(([key]) => key !== 'skill'))
  return (
    <div className="exe-log-skill-card">
      <div className="exe-log-skill-header">
        <IconSkills />
        <strong>{skillName}</strong>
      </div>
      <section className="exe-log-skill-section">
        <SkillValue value={invocationArgs} />
      </section>
      <section className="exe-log-skill-section exe-log-skill-output-section">
        <div className="exe-log-skill-markdown markdown-body">
          <MarkdownDetail content={item.detail || ''} />
        </div>
      </section>
    </div>
  )
}
```

- [ ] **Step 3: Style the card, structured arguments, and Markdown typography**

```css
.exe-log-skill-card {
  --skill-accent: #7c5cff;
  position: relative;
  overflow: hidden;
  border: 1px solid rgba(124, 92, 255, 0.2);
  border-radius: 10px;
  background: linear-gradient(145deg, rgba(124, 92, 255, 0.055), transparent 34%), var(--bg-panel);
}

.exe-log-skill-markdown {
  max-height: 360px;
  overflow: auto;
  font-family: var(--font-sans, sans-serif);
  font-size: 13px;
  line-height: 1.75;
}
```

- [ ] **Step 4: Verify both theme variants and narrow layouts**

Run: `npm run build`

Expected: Electron Vite completes the main, preload, and renderer builds with exit code `0`.

- [ ] **Step 5: Commit when requested by the repository owner**

```bash
git add src/renderer/src/components/chat/ExecutionLogDetail/index.tsx src/renderer/src/components/chat/ExecutionLogDetail/ExecutionLogDetail.css docs/superpowers/plans/2026-07-11-skill-invocation-detail-polish.md
git commit -m "style: beautify skill invocation details"
```
