import { useEffect } from 'react'
import { useChatStore } from '../../../stores/chatStore'
import type { TaskUpdatePayload } from '../../../../../shared/types/task'

/**
 * 订阅主进程的 Task 全量清单广播（TASK_UPDATED），驱动 chatStore.tasks。
 * 始终更新 payload 所属会话；仅活动会话会同步到顶层 tasks 展示状态。
 */
export function useTaskSubscription(): void {
  useEffect(() => {
    const api = (window as any).api
    if (!api?.task?.subscribe) return

    const unsub = api.task.subscribe((payload: TaskUpdatePayload) => {
      useChatStore.getState().setSessionTasks(payload.sessionId, payload.tasks)
    })

    return () => {
      unsub?.()
    }
  }, [])
}
