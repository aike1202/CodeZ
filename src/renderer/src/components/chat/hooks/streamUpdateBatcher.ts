export interface StreamUpdateCallbacks {
  appendMain: (delta: string, reasoningDelta: string) => void
  appendSubAgent: (subAgentId: string, delta: string, reasoningDelta: string) => void
}

interface BufferedChunk {
  delta: string
  reasoningDelta: string
}

export interface StreamUpdateBatcher {
  pushMain: (delta: string, reasoningDelta?: string) => void
  pushSubAgent: (subAgentId: string, delta: string, reasoningDelta: string) => void
  flush: () => void
  cancel: () => void
}

const STREAM_RENDER_INTERVAL_MS = 40

export function createStreamUpdateBatcher(
  callbacks: StreamUpdateCallbacks,
  intervalMs = STREAM_RENDER_INTERVAL_MS
): StreamUpdateBatcher {
  let main: BufferedChunk = { delta: '', reasoningDelta: '' }
  const subAgents = new Map<string, BufferedChunk>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = () => {
    if (!timer) return
    clearTimeout(timer)
    timer = null
  }

  const flush = () => {
    clearTimer()

    const pendingMain = main
    main = { delta: '', reasoningDelta: '' }
    const pendingSubAgents = Array.from(subAgents.entries())
    subAgents.clear()

    if (pendingMain.delta || pendingMain.reasoningDelta) {
      callbacks.appendMain(pendingMain.delta, pendingMain.reasoningDelta)
    }
    for (const [subAgentId, chunk] of pendingSubAgents) {
      callbacks.appendSubAgent(subAgentId, chunk.delta, chunk.reasoningDelta)
    }
  }

  const schedule = () => {
    if (timer) return
    timer = setTimeout(flush, intervalMs)
  }

  return {
    pushMain: (delta, reasoningDelta = '') => {
      if (!delta && !reasoningDelta) return
      main.delta += delta
      main.reasoningDelta += reasoningDelta
      schedule()
    },
    pushSubAgent: (subAgentId, delta, reasoningDelta) => {
      if (!delta && !reasoningDelta) return
      const pending = subAgents.get(subAgentId) || { delta: '', reasoningDelta: '' }
      pending.delta += delta
      pending.reasoningDelta += reasoningDelta
      subAgents.set(subAgentId, pending)
      schedule()
    },
    flush,
    cancel: () => {
      clearTimer()
      main = { delta: '', reasoningDelta: '' }
      subAgents.clear()
    }
  }
}
