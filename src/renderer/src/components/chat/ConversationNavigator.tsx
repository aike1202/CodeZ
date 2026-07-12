import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage } from '../../stores/chatStore'
import './ConversationNavigator.css'

interface ConversationNavigatorProps {
  messages: ChatMessage[]
  containerRef: React.RefObject<HTMLDivElement>
  contentRef: React.RefObject<HTMLDivElement>
}

interface ConversationMarker {
  id: string
  label: string
  ratio: number
  scrollTop: number
  contentTop: number
  turn: number
}

const MARKER_TOP_OFFSET = 20
const MARKER_MIN_GAP_PX = 8
const DRAG_THRESHOLD_PX = 4
const MEASURE_DELAY_MS = 80
const SUMMARY_MAX_LENGTH = 160
const NAVIGATOR_VERTICAL_PADDING = 14
const NAVIGATOR_MIN_HEIGHT = 78
const NAVIGATOR_MAX_HEIGHT = 374
const MARKER_SPACING_PX = 12

function summarizeMessage(message: ChatMessage): string {
  const summary = message.content.replace(/\s+/g, ' ').trim()
  if (summary) {
    return summary.length > SUMMARY_MAX_LENGTH
      ? `${summary.slice(0, SUMMARY_MAX_LENGTH).trimEnd()}...`
      : summary
  }
  if (message.attachments?.length) return `${message.attachments.length} 个图片附件`
  return '空消息'
}

function spreadDenseMarkers(
  markers: ConversationMarker[],
  trackHeight: number
): ConversationMarker[] {
  if (markers.length < 2 || trackHeight <= 0) return markers

  const gap = Math.min(MARKER_MIN_GAP_PX, trackHeight / (markers.length - 1))
  const positions = markers.map((marker) => marker.ratio * trackHeight)
  for (let index = 1; index < positions.length; index++) {
    positions[index] = Math.max(positions[index], positions[index - 1] + gap)
  }
  if (positions[positions.length - 1] > trackHeight) {
    positions[positions.length - 1] = trackHeight
    for (let index = positions.length - 2; index >= 0; index--) {
      positions[index] = Math.min(positions[index], positions[index + 1] - gap)
    }
  }

  return markers.map((marker, index) => ({
    ...marker,
    ratio: Math.max(0, Math.min(positions[index] / trackHeight, 1))
  }))
}

function ConversationNavigator({
  messages,
  containerRef,
  contentRef
}: ConversationNavigatorProps): React.ReactElement | null {
  const railRef = useRef<HTMLDivElement>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const measurementTimerRef = useRef<number | null>(null)
  const isDraggingRef = useRef(false)
  const didDragRef = useRef(false)
  const pointerStartYRef = useRef(0)
  const pendingMarkerRef = useRef<ConversationMarker | null>(null)
  const [markers, setMarkers] = useState<ConversationMarker[]>([])
  const [activeMarkerId, setActiveMarkerId] = useState<string | null>(null)
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  const userMessages = useMemo(
    () => messages.filter((message) => message.role === 'user'),
    [messages]
  )
  const navigationItems = useMemo(
    () => userMessages.map((message, index) => ({
      id: message.id,
      label: summarizeMessage(message),
      turn: index + 1
    })),
    [userMessages]
  )

  const measureMarkers = useCallback(() => {
    const container = containerRef.current
    if (!container || navigationItems.length < 2) {
      setMarkers([])
      setActiveMarkerId(null)
      return
    }

    const maxScroll = container.scrollHeight - container.clientHeight
    if (maxScroll <= 0) {
      setMarkers([])
      setActiveMarkerId(null)
      return
    }

    const rowById = new Map<string, HTMLElement>()
    container.querySelectorAll<HTMLElement>('[data-chat-message-id]').forEach((row) => {
      const messageId = row.dataset.chatMessageId
      if (messageId) rowById.set(messageId, row)
    })

    const containerTop = container.getBoundingClientRect().top
    const rawMarkers = navigationItems.flatMap((item) => {
      const row = rowById.get(item.id)
      if (!row) return []

      const contentTop = row.getBoundingClientRect().top - containerTop + container.scrollTop
      const scrollTop = Math.max(0, Math.min(contentTop - MARKER_TOP_OFFSET, maxScroll))
      return [{
        id: item.id,
        label: item.label,
        ratio: (item.turn - 1) / (navigationItems.length - 1),
        scrollTop,
        contentTop,
        turn: item.turn
      }]
    })

    const navigatorHeight = Math.min(
      Math.max(navigationItems.length * MARKER_SPACING_PX + NAVIGATOR_VERTICAL_PADDING, NAVIGATOR_MIN_HEIGHT),
      Math.min(container.clientHeight - 36, NAVIGATOR_MAX_HEIGHT)
    )
    const trackHeight = Math.max(navigatorHeight - NAVIGATOR_VERTICAL_PADDING, 1)
    setMarkers(spreadDenseMarkers(rawMarkers, trackHeight))
  }, [containerRef, navigationItems])

  const scheduleMeasurement = useCallback(() => {
    if (measurementTimerRef.current !== null) return
    measurementTimerRef.current = window.setTimeout(() => {
      measurementTimerRef.current = null
      measureMarkers()
    }, MEASURE_DELAY_MS)
  }, [measureMarkers])

  useEffect(() => {
    measureMarkers()

    const content = contentRef.current
    const container = containerRef.current
    if (!content || !container) return

    const resizeObserver = new ResizeObserver(scheduleMeasurement)
    const observeContainerChildren = () => {
      resizeObserver.observe(container)
      resizeObserver.observe(content)
      Array.from(container.children).forEach((element) => resizeObserver.observe(element))
    }
    observeContainerChildren()

    const mutationObserver = new MutationObserver(() => {
      observeContainerChildren()
      scheduleMeasurement()
    })
    mutationObserver.observe(container, { childList: true })
    window.addEventListener('resize', scheduleMeasurement)
    return () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('resize', scheduleMeasurement)
      if (measurementTimerRef.current !== null) {
        window.clearTimeout(measurementTimerRef.current)
        measurementTimerRef.current = null
      }
    }
  }, [containerRef, contentRef, measureMarkers, scheduleMeasurement])

  useEffect(() => {
    const container = containerRef.current
    if (!container || markers.length === 0) return

    const updateActiveMarker = () => {
      scrollFrameRef.current = null
      const probe = container.scrollTop + container.clientHeight * 0.2
      let activeId = markers[0].id
      for (const marker of markers) {
        if (marker.contentTop > probe) break
        activeId = marker.id
      }
      setActiveMarkerId((current) => current === activeId ? current : activeId)
    }

    const handleScroll = () => {
      if (scrollFrameRef.current !== null) return
      scrollFrameRef.current = requestAnimationFrame(updateActiveMarker)
    }

    updateActiveMarker()
    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', handleScroll)
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current)
        scrollFrameRef.current = null
      }
    }
  }, [containerRef, markers])

  const scrollToMarker = useCallback((marker: ConversationMarker) => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    containerRef.current?.scrollTo({
      top: marker.scrollTop,
      behavior: reduceMotion ? 'auto' : 'smooth'
    })
  }, [containerRef])

  const scrollFromPointer = useCallback((clientY: number) => {
    const container = containerRef.current
    const rail = railRef.current
    if (!container || !rail) return

    const bounds = rail.getBoundingClientRect()
    const ratio = Math.max(0, Math.min((clientY - bounds.top) / bounds.height, 1))
    container.scrollTop = ratio * Math.max(0, container.scrollHeight - container.clientHeight)
  }, [containerRef])

  const findNearestMarker = useCallback((clientY: number) => {
    const rail = railRef.current
    if (!rail || markers.length === 0) return null

    const bounds = rail.getBoundingClientRect()
    const pointerY = clientY - bounds.top
    let nearest = markers[0]
    let nearestDistance = Math.abs(nearest.ratio * bounds.height - pointerY)
    for (let index = 1; index < markers.length; index++) {
      const marker = markers[index]
      const distance = Math.abs(marker.ratio * bounds.height - pointerY)
      if (distance < nearestDistance) {
        nearest = marker
        nearestDistance = distance
      }
    }
    return { marker: nearest, distance: nearestDistance }
  }, [markers])

  if (markers.length < 2) return null

  return (
    <aside
      className="conversation-navigator"
      style={{
        height: `${Math.min(
          Math.max(markers.length * MARKER_SPACING_PX + NAVIGATOR_VERTICAL_PADDING, NAVIGATOR_MIN_HEIGHT),
          NAVIGATOR_MAX_HEIGHT
        )}px`
      }}
      aria-label="对话位置导航"
    >
      <div
        ref={railRef}
        className={`conversation-navigator__rail${isDragging ? ' is-dragging' : ''}`}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          isDraggingRef.current = true
          didDragRef.current = false
          pointerStartYRef.current = event.clientY
          const nearest = findNearestMarker(event.clientY)
          pendingMarkerRef.current = nearest && nearest.distance <= 12
            ? nearest.marker
            : null
        }}
        onPointerMove={(event) => {
          if (isDraggingRef.current) {
            if (!didDragRef.current) {
              if (Math.abs(event.clientY - pointerStartYRef.current) < DRAG_THRESHOLD_PX) return
              didDragRef.current = true
              setIsDragging(true)
            }
            scrollFromPointer(event.clientY)
            return
          }
          const nearest = findNearestMarker(event.clientY)
          setHoveredMarkerId(nearest && nearest.distance <= 12 ? nearest.marker.id : null)
        }}
        onPointerUp={(event) => {
          if (!isDraggingRef.current) return
          if (!didDragRef.current) {
            const pendingMarker = pendingMarkerRef.current
            if (pendingMarker) scrollToMarker(pendingMarker)
            else scrollFromPointer(event.clientY)
          }
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          isDraggingRef.current = false
          didDragRef.current = false
          pendingMarkerRef.current = null
          setIsDragging(false)
        }}
        onPointerCancel={() => {
          isDraggingRef.current = false
          didDragRef.current = false
          pendingMarkerRef.current = null
          setIsDragging(false)
        }}
        onPointerLeave={() => {
          if (!isDraggingRef.current) setHoveredMarkerId(null)
        }}
      >
        {markers.map((marker) => {
          const isActive = marker.id === activeMarkerId
          const isHovered = marker.id === hoveredMarkerId
          const edgeClass = marker.ratio < 0.12
            ? ' is-near-top'
            : marker.ratio > 0.88
              ? ' is-near-bottom'
              : ''

          return (
            <button
              key={marker.id}
              type="button"
              className={`conversation-navigator__marker${isActive ? ' is-active' : ''}${isHovered ? ' is-hovered' : ''}${edgeClass}`}
              style={{ top: `${marker.ratio * 100}%` }}
              onClick={(event) => {
                event.stopPropagation()
                scrollToMarker(marker)
              }}
              onFocus={() => setHoveredMarkerId(marker.id)}
              onBlur={() => setHoveredMarkerId(null)}
              aria-label={`跳转到第 ${marker.turn} 轮对话：${marker.label}`}
              aria-current={isActive ? 'location' : undefined}
            >
              <span className="conversation-navigator__tick" aria-hidden="true" />
              {isHovered ? (
                <span className="conversation-navigator__tooltip" role="tooltip">
                  <span className="conversation-navigator__summary">{marker.label}</span>
                  <span className="conversation-navigator__meta">第 {marker.turn} 轮对话</span>
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </aside>
  )
}

function areNavigatorPropsEqual(
  previous: ConversationNavigatorProps,
  next: ConversationNavigatorProps
): boolean {
  if (previous.containerRef !== next.containerRef || previous.contentRef !== next.contentRef) {
    return false
  }

  const previousUserMessages = previous.messages.filter((message) => message.role === 'user')
  const nextUserMessages = next.messages.filter((message) => message.role === 'user')
  if (previousUserMessages.length !== nextUserMessages.length) return false

  return previousUserMessages.every((message, index) => {
    const nextMessage = nextUserMessages[index]
    return message.id === nextMessage.id
      && message.content === nextMessage.content
      && message.attachments?.length === nextMessage.attachments?.length
  })
}

export default React.memo(ConversationNavigator, areNavigatorPropsEqual)
