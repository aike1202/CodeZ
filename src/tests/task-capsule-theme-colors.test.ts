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
