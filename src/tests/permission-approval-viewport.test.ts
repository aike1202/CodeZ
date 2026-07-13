import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/chat/PermissionApprovalWidget.css'),
  'utf8'
)
const component = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/chat/PermissionApprovalWidget.tsx'),
  'utf8'
)

function ruleFor(selector: string): string {
  const match = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`))
  return match?.[1] ?? ''
}

describe('PermissionApprovalWidget viewport layout', () => {
  it('caps the card and scrolls overflowing requests inside it', () => {
    expect(ruleFor('.permission-approval-float-card')).toContain('max-height: min(70dvh, 720px)')
    expect(ruleFor('.permission-approval-float-card')).toContain('overflow: hidden')
    expect(ruleFor('.permission-approval-list')).toContain('overflow-y: auto')
  })

  it('keeps request actions outside the bounded detail scroller', () => {
    expect(ruleFor('.permission-approval-detail-scroll')).toContain('max-height: clamp(96px, 22dvh, 220px)')
    expect(ruleFor('.permission-approval-detail-scroll')).toContain('overflow: auto')
    expect(component).toMatch(
      /className="permission-approval-detail-scroll"[\s\S]*?<\/div>\s*<Flex[^>]+className="permission-approval-actions"/
    )
  })
})
