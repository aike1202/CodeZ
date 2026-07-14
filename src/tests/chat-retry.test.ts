import { describe, expect, it, vi } from 'vitest'
import { getDefaultRetryDelayMs, streamWithTimeoutRetry } from '../main/services/chat/retry'
import type { StreamCallbacks } from '../main/services/ChatService'

describe('streamWithTimeoutRetry', () => {
  it('uses the requested default retry backoff schedule', () => {
    expect(Array.from({ length: 10 }, (_, index) => getDefaultRetryDelayMs(index + 1))).toEqual([
      5_000,
      10_000,
      20_000,
      40_000,
      60_000,
      90_000,
      120_000,
      150_000,
      180_000,
      210_000
    ])
  })

  it('uses a 120 second idle timeout by default', async () => {
    vi.useFakeTimers()

    const errors: string[] = []
    const runPromise = streamWithTimeoutRetry(
      async (attemptCallbacks, signal) => {
        attemptCallbacks.onUsage?.({ inputTokens: 1, outputTokens: 0, totalTokens: 1 })
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
      {
        onChunk: () => undefined,
        onDone: () => undefined,
        onError: (error) => errors.push(error)
      },
      new AbortController().signal,
      { maxRetries: 0, maxIdleRetries: 0 }
    )

    await vi.advanceTimersByTimeAsync(119_999)
    expect(errors).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await runPromise

    expect(errors).toEqual(['响应流已超时中断（120s 无新数据），已自动停止。请检查网络连接后重试。'])

    vi.useRealTimers()
  })

  it('retries when the first response times out before any chunk is emitted', async () => {
    vi.useFakeTimers()

    const chunks: string[] = []
    const errors: string[] = []
    const retries: number[] = []
    let attempts = 0

    const callbacks: StreamCallbacks = {
      onChunk: (delta) => chunks.push(delta),
      onDone: () => {},
      onError: (error) => errors.push(error)
    }

    const runPromise = streamWithTimeoutRetry(
      async (attemptCallbacks, signal) => {
        attempts++
        if (attempts === 1) {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
          return
        }

        attemptCallbacks.onChunk('ok')
        attemptCallbacks.onDone('ok', 'stop')
      },
      callbacks,
      new AbortController().signal,
      {
        firstByteTimeoutMs: 10,
        idleTimeoutMs: 1_000,
        maxRetries: 1,
        retryDelayMs: 5,
        onRetry: (attempt) => retries.push(attempt)
      }
    )

    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(5)
    await runPromise

    expect(attempts).toBe(2)
    expect(retries).toEqual([1])
    expect(chunks).toEqual(['ok'])
    expect(errors).toEqual([])

    vi.useRealTimers()
  })

  it('retries an idle timeout after streaming has started', async () => {
    vi.useFakeTimers()

    const chunks: string[] = []
    const errors: string[] = []
    const retries: Array<{ attempt: number; reason: string; retryNumber: number }> = []
    let attempts = 0

    const callbacks: StreamCallbacks = {
      onChunk: (delta) => chunks.push(delta),
      onDone: () => {},
      onError: (error) => errors.push(error)
    }

    const runPromise = streamWithTimeoutRetry(
      async (attemptCallbacks, signal) => {
        attempts++
        if (attempts === 1) {
          attemptCallbacks.onChunk('partial')
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
          return
        }

        attemptCallbacks.onChunk('ok')
        attemptCallbacks.onDone('ok', 'stop')
      },
      callbacks,
      new AbortController().signal,
      {
        firstByteTimeoutMs: 1_000,
        idleTimeoutMs: 10,
        maxRetries: 0,
        maxIdleRetries: 1,
        retryDelayMs: 5,
        onRetry: (attempt, reason, retryNumber) => retries.push({ attempt, reason, retryNumber })
      }
    )

    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(5)
    await runPromise

    expect(attempts).toBe(2)
    expect(retries).toEqual([{ attempt: 1, reason: 'idle', retryNumber: 1 }])
    expect(chunks).toEqual(['partial', 'ok'])
    expect(errors).toEqual([])

    vi.useRealTimers()
  })

  it('reports an error after idle retries are exhausted', async () => {
    vi.useFakeTimers()

    const errors: Array<{ message: string; code?: string }> = []
    let attempts = 0
    const runPromise = streamWithTimeoutRetry(
      async (attemptCallbacks, signal) => {
        attempts++
        attemptCallbacks.onChunk(`partial-${attempts}`)
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
      {
        onChunk: () => undefined,
        onDone: () => undefined,
        onError: (message, code) => errors.push({ message, code })
      },
      new AbortController().signal,
      {
        firstByteTimeoutMs: 1_000,
        idleTimeoutMs: 10,
        maxRetries: 0,
        maxIdleRetries: 1,
        retryDelayMs: 5
      }
    )

    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(5)
    await vi.advanceTimersByTimeAsync(10)
    await runPromise

    expect(attempts).toBe(2)
    expect(errors).toEqual([{
      message: '响应流已超时中断（10ms 无新数据），已自动重试 1 次，现已停止。请检查网络连接后重试。',
      code: 'NETWORK'
    }])

    vi.useRealTimers()
  })

  it('treats a usage-only provider event as the first response byte', async () => {
    vi.useFakeTimers()

    const usages: number[] = []
    const errors: string[] = []
    let attempts = 0
    const runPromise = streamWithTimeoutRetry(
      async (attemptCallbacks, signal) => {
        attempts++
        attemptCallbacks.onUsage?.({ inputTokens: 10, outputTokens: 0, totalTokens: 10 })
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
      {
        onChunk: () => undefined,
        onDone: () => undefined,
        onError: (error) => errors.push(error),
        onUsage: (usage) => usages.push(usage.inputTokens)
      },
      new AbortController().signal,
      {
        firstByteTimeoutMs: 5,
        idleTimeoutMs: 10,
        maxRetries: 1,
        maxIdleRetries: 0,
        retryDelayMs: 1
      }
    )

    await vi.advanceTimersByTimeAsync(10)
    await runPromise

    expect(attempts).toBe(1)
    expect(usages).toEqual([10])
    expect(errors).toEqual(['响应流已超时中断（10ms 无新数据），已自动停止。请检查网络连接后重试。'])

    vi.useRealTimers()
  })
})
