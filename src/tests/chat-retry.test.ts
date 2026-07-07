import { describe, expect, it, vi } from 'vitest'
import { streamWithTimeoutRetry } from '../main/services/chat/retry'
import type { StreamCallbacks } from '../main/services/ChatService'

describe('streamWithTimeoutRetry', () => {
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

  it('does not retry idle timeout after streaming has started', async () => {
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
        attemptCallbacks.onChunk('partial')
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
      callbacks,
      new AbortController().signal,
      {
        firstByteTimeoutMs: 1_000,
        idleTimeoutMs: 10,
        maxRetries: 2,
        retryDelayMs: 5,
        onRetry: (attempt) => retries.push(attempt)
      }
    )

    await vi.advanceTimersByTimeAsync(10)
    await runPromise

    expect(attempts).toBe(1)
    expect(retries).toEqual([])
    expect(chunks).toEqual(['partial'])
    expect(errors).toEqual(['响应流已超时中断（10ms 无新数据），已自动停止。请检查网络连接后重试。'])

    vi.useRealTimers()
  })
})
