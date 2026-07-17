/** 距底部小于视口高度的此比例算“在底部”。 */
const SCROLL_BOTTOM_RATIO = 0.15
/** “在底部”阈值的最小像素值，用于保护小视口。 */
const SCROLL_BOTTOM_MIN_PX = 100

type ScrollMetrics = Pick<HTMLElement, 'clientHeight' | 'scrollHeight' | 'scrollTop'>

export type ScrollFollowDecision = 'pause' | 'resume' | 'unchanged'

export function shouldPauseForWheel(deltaY: number): boolean {
  return deltaY < 0
}

export function isNearBottom(container: ScrollMetrics): boolean {
  const distance = container.scrollHeight - container.scrollTop - container.clientHeight
  return distance < Math.max(container.clientHeight * SCROLL_BOTTOM_RATIO, SCROLL_BOTTOM_MIN_PX)
}

export function getScrollFollowDecision(
  container: ScrollMetrics,
  previousScrollTop: number | null
): ScrollFollowDecision {
  if (previousScrollTop === null || container.scrollTop === previousScrollTop) {
    return 'unchanged'
  }

  if (container.scrollTop < previousScrollTop) {
    return 'pause'
  }

  return isNearBottom(container) ? 'resume' : 'unchanged'
}
