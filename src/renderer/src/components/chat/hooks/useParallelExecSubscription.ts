import { useEffect } from 'react'
import { useParallelExecStore } from '../../../stores/parallelExecStore'
import { useChatStore } from '../../../stores/chatStore'

/**
 * 订阅主进程的并行执行广播事件，驱动 parallelExecStore。
 * 在聊天布局挂载时启用一次，卸载时取消订阅。
 */
export function useParallelExecSubscription(): void {
  useEffect(() => {
    const api = (window as any).api
    if (!api?.parallel?.subscribe) return

    const unsub = api.parallel.subscribe({
      onStarted: (payload: any) => {
        if (payload.sessionId && payload.sessionId !== useChatStore.getState().activeSessionId) return
        useParallelExecStore.getState().handleStarted(payload)
      },
      onWaveUpdate: (payload: any) => {
        if (payload.sessionId && payload.sessionId !== useChatStore.getState().activeSessionId) return
        useParallelExecStore.getState().handleWaveUpdate(payload)
      },
      onDone: (payload: any) => {
        if (payload.sessionId && payload.sessionId !== useChatStore.getState().activeSessionId) return
        useParallelExecStore.getState().handleDone(payload)
      },
      onExecutionEvent: (event: any) => {
        if (event.sessionId !== useChatStore.getState().activeSessionId) return
        useParallelExecStore.getState().handleExecutionEvent(event)
      }
    })

    return () => {
      unsub?.()
    }
  }, [])
}
