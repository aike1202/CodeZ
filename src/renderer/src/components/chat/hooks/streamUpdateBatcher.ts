export interface StreamUpdateCallbacks {
  appendMain: (delta: string, reasoningDelta: string) => void
}

interface BufferedSegment {
  kind: 'text' | 'reasoning'
  content: string
}

export interface StreamUpdateBatcher {
  pushMain: (delta: string, reasoningDelta?: string) => void
  flush: () => void
  cancel: () => void
}

const STREAM_RENDER_INTERVAL_MS = 40

export function createStreamUpdateBatcher(
  callbacks: StreamUpdateCallbacks,
  intervalMs = STREAM_RENDER_INTERVAL_MS
): StreamUpdateBatcher {
  let main: BufferedSegment[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = () => {
    if (!timer) return
    clearTimeout(timer)
    timer = null
  }

  const flush = () => {
    clearTimer()

    const pendingMain = main
    main = []

    flushSegments(pendingMain, callbacks.appendMain)
  }

  const schedule = () => {
    if (timer) return
    timer = setTimeout(flush, intervalMs)
  }

  return {
    pushMain: (delta, reasoningDelta = '') => {
      if (!delta && !reasoningDelta) return
      appendSegments(main, delta, reasoningDelta)
      schedule()
    },
    flush,
    cancel: () => {
      clearTimer()
      main = []
    }
  }
}

function appendSegments(segments: BufferedSegment[], delta: string, reasoningDelta: string): void {
  appendSegment(segments, 'text', delta)
  appendSegment(segments, 'reasoning', reasoningDelta)
}

function appendSegment(
  segments: BufferedSegment[],
  kind: BufferedSegment['kind'],
  content: string
): void {
  if (!content) return
  const last = segments[segments.length - 1]
  if (last?.kind === kind) {
    last.content += content
    return
  }
  segments.push({ kind, content })
}

function flushSegments(
  segments: BufferedSegment[],
  append: (delta: string, reasoningDelta: string) => void
): void {
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]
    const next = segments[index + 1]
    if (segment.kind === 'text' && next?.kind === 'reasoning') {
      append(segment.content, next.content)
      index += 1
    } else if (segment.kind === 'text') {
      append(segment.content, '')
    } else {
      append('', segment.content)
    }
  }
}
