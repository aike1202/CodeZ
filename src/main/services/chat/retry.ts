import type { StreamCallbacks } from './types'

export interface StreamRetryOptions {
  firstByteTimeoutMs?: number
  idleTimeoutMs?: number
  maxRetries?: number
  retryDelayMs?: number
  onFirstByteTimeout?: (attempt: number) => void
  onIdleTimeout?: (attempt: number) => void
  onRetry?: (attempt: number) => void
}

export type StreamAttempt = (callbacks: StreamCallbacks, signal: AbortSignal) => Promise<void>

const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 30_000
const DEFAULT_IDLE_TIMEOUT_MS = 60_000
const DEFAULT_MAX_RETRIES = 10

export function getDefaultRetryDelayMs(retryAttempt: number): number {
  const schedule = [5_000, 10_000, 20_000, 40_000, 60_000, 90_000]
  if (retryAttempt <= schedule.length) return schedule[Math.max(1, retryAttempt) - 1]
  return 90_000 + (retryAttempt - schedule.length) * 30_000
}

function formatDuration(ms: number): string {
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve()

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function streamWithTimeoutRetry(
  startAttempt: StreamAttempt,
  callbacks: StreamCallbacks,
  externalSignal: AbortSignal,
  options: StreamRetryOptions = {}
): Promise<void> {
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES)

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (externalSignal.aborted) return

    const attemptController = new AbortController()
    const abortAttempt = () => attemptController.abort()
    externalSignal.addEventListener('abort', abortAttempt, { once: true })

    let firstByteTimer: ReturnType<typeof setTimeout> | null = null
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let sawFirstByte = false
    let completed = false
    let timedOutBeforeFirstByte = false
    let idleTimedOut = false
    let suppressCallbacks = false

    const clearTimers = () => {
      if (firstByteTimer) {
        clearTimeout(firstByteTimer)
        firstByteTimer = null
      }
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
    }

    const markFirstByte = () => {
      if (sawFirstByte) return
      sawFirstByte = true
      if (firstByteTimer) {
        clearTimeout(firstByteTimer)
        firstByteTimer = null
      }
    }

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleTimedOut = true
        suppressCallbacks = true
        clearTimers()
        options.onIdleTimeout?.(attempt)
        callbacks.onError(`响应流已超时中断（${formatDuration(idleTimeoutMs)} 无新数据），已自动停止。请检查网络连接后重试。`)
        attemptController.abort()
      }, idleTimeoutMs)
    }

    firstByteTimer = setTimeout(() => {
      if (sawFirstByte || completed) return
      timedOutBeforeFirstByte = true
      suppressCallbacks = true
      clearTimers()
      options.onFirstByteTimeout?.(attempt)
      attemptController.abort()
    }, firstByteTimeoutMs)

    const attemptCallbacks: StreamCallbacks = {
      onChunk: (delta, reasoningDelta, toolCalls, thoughtSignature) => {
        if (suppressCallbacks || externalSignal.aborted) return
        markFirstByte()
        resetIdleTimer()
        callbacks.onChunk(delta, reasoningDelta, toolCalls, thoughtSignature)
      },
      onDone: (fullContent, stopReason, txId) => {
        if (suppressCallbacks || externalSignal.aborted) return
        markFirstByte()
        completed = true
        clearTimers()
        callbacks.onDone(fullContent, stopReason, txId)
      },
      onError: (error, code) => {
        if (suppressCallbacks || externalSignal.aborted) return
        completed = true
        clearTimers()
        callbacks.onError(error, code)
      },
      onUsage: (usage) => {
        if (suppressCallbacks || externalSignal.aborted) return
        callbacks.onUsage?.(usage)
      }
    }

    try {
      await startAttempt(attemptCallbacks, attemptController.signal)
    } catch (error) {
      if (!timedOutBeforeFirstByte && !idleTimedOut && !attemptController.signal.aborted && !externalSignal.aborted) {
        completed = true
        clearTimers()
        callbacks.onError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      clearTimers()
      externalSignal.removeEventListener('abort', abortAttempt)
    }

    if (externalSignal.aborted || completed || idleTimedOut) return

    if (timedOutBeforeFirstByte) {
      if (attempt <= maxRetries) {
        options.onRetry?.(attempt)
        const retryDelayMs = Math.max(0, options.retryDelayMs ?? getDefaultRetryDelayMs(attempt))
        await wait(retryDelayMs, externalSignal)
        continue
      }

      callbacks.onError(
        `等待首个响应超时（${formatDuration(firstByteTimeoutMs)}），已重试 ${maxRetries} 次，请检查网络 / Provider / 模型是否可用。`
      )
      return
    }

    return
  }
}
