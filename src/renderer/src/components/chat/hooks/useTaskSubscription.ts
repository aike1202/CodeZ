import { useEffect } from 'react'
import { useChatStore } from '../../../stores/chatStore'

/**
 * 订阅主进程的 Task 全量清单广播（TASK_UPDATED），驱动 chatStore.tasks。
 * 仅当 payload.sessionId 匹配当前活跃会话时更新，避免跨会话串扰。
 */
export function useTaskSubscription(): void {
  useEffect(() => {
    const api = (window as any).api
    if (!api?.task?.subscribe) return

    const unsub = api.task.subscribe((payload: { sessionId: string; tasks: any[] }) => {
      const { activeSessionId, setTasks } = useChatStore.getState()
      if (payload.sessionId === activeSessionId) {
        setTasks(payload.tasks)
      }
    })

    return () => {
      unsub?.()
    }
  }, [])
}
