import { describe, it, expect } from 'vitest'
import { APP_NAME, APP_SUBTITLE, CURRENT_PHASE, APP_VERSION } from '@shared/constants/app'

describe('App 共享常量', () => {
  it('APP_NAME 应为 MyAgent', () => {
    expect(APP_NAME).toBe('MyAgent')
  })

  it('APP_SUBTITLE 应为 Agent Coding Desktop', () => {
    expect(APP_SUBTITLE).toBe('Agent Coding Desktop')
  })

  it('CURRENT_PHASE 应包含阶段 0', () => {
    expect(CURRENT_PHASE).toContain('阶段 0')
  })

  it('APP_VERSION 应为 0.1.0', () => {
    expect(APP_VERSION).toBe('0.1.0')
  })
})
