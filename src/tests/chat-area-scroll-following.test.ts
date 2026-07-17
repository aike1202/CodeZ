import { describe, expect, it } from 'vitest'
import {
  getScrollFollowDecision,
  isNearBottom,
  shouldPauseForWheel
} from '../renderer/src/components/chat/ChatArea/scrollFollowing'

describe('ChatArea scroll following', () => {
  it('pauses before an upward wheel input can race the next log resize', () => {
    expect(shouldPauseForWheel(-1)).toBe(true)
    expect(shouldPauseForWheel(1)).toBe(false)
  })

  it('pauses immediately when the user moves upward near the bottom', () => {
    const metrics = { clientHeight: 800, scrollHeight: 2_000, scrollTop: 1_150 }

    expect(isNearBottom(metrics)).toBe(true)
    expect(getScrollFollowDecision(metrics, 1_200)).toBe('pause')
  })

  it('resumes only after downward movement reaches the bottom threshold', () => {
    expect(getScrollFollowDecision(
      { clientHeight: 800, scrollHeight: 2_000, scrollTop: 1_050 },
      1_000
    )).toBe('unchanged')

    expect(getScrollFollowDecision(
      { clientHeight: 800, scrollHeight: 2_000, scrollTop: 1_100 },
      1_050
    )).toBe('resume')
  })

  it('does not infer user intent without an actual scroll position change', () => {
    const metrics = { clientHeight: 500, scrollHeight: 1_000, scrollTop: 500 }

    expect(getScrollFollowDecision(metrics, null)).toBe('unchanged')
    expect(getScrollFollowDecision(metrics, 500)).toBe('unchanged')
  })
})
