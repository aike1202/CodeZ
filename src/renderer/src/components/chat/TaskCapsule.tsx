import React, { useState, useRef, useEffect } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { CheckCircle2, CircleDashed, Loader2, ListTodo, XCircle, ChevronDown, ChevronUp } from 'lucide-react'
import type { TaskItem, TaskStatus } from '../../../../shared/types/task'
import '../PlanCapsule.css'
import './TaskCapsule.css'

/** 展示顺序：in_progress → pending → completed → cancelled */
const STATUS_ORDER: Record<TaskStatus, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  cancelled: 3
}

export const TaskCapsule: React.FC = () => {
  const tasks = useChatStore((s) => s.tasks)
  const [expanded, setExpanded] = useState(false)
  const capsuleRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (capsuleRef.current && !capsuleRef.current.contains(event.target as Node)) {
        setExpanded(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  if (!tasks || tasks.length === 0) {
    return null
  }

  const total = tasks.length
  const completed = tasks.filter((t) => t.status === 'completed').length
  const inProgress = tasks.find((t) => t.status === 'in_progress')
  const allDone = completed === total

  const sorted = [...tasks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])

  // 从 tasks 里取第一个有 title/subtitle 的值作为清单头
  const listTitle = tasks.find(t => t.title)?.title
  const listSubtitle = tasks.find(t => t.subtitle)?.subtitle

  const getStatusIcon = (status: TaskStatus) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 className="step-icon completed" size={14} />
      case 'in_progress':
        return <Loader2 className="step-icon in-progress spin" size={14} />
      case 'cancelled':
        return <XCircle className="step-icon cancelled" size={14} />
      default:
        return <CircleDashed className="step-icon pending" size={14} />
    }
  }

  const headText = (task: TaskItem) => task.activeForm || task.subject

  return (
    <div className={`plan-capsule-wrapper task-capsule-wrapper ${expanded ? 'expanded' : ''}`} ref={capsuleRef}>
      <div className={`plan-capsule ${allDone ? '' : 'executing'}`} onClick={() => setExpanded(!expanded)}>
        {allDone ? (
          <CheckCircle2 className="plan-capsule-icon success" size={14} />
        ) : (
          <ListTodo className="plan-capsule-icon" size={14} />
        )}
        <span className="plan-capsule-text">
          {inProgress ? headText(inProgress) : `Tasks ${completed}/${total}`}
        </span>
        {expanded ? <ChevronUp size={14} className="chevron" /> : <ChevronDown size={14} className="chevron" />}
      </div>

      {expanded && (
        <div className="plan-capsule-popover">
          <div className="plan-capsule-header">
            <div>
              {listTitle ? <h4>{listTitle}</h4> : <h4>任务清单</h4>}
              {listSubtitle ? <p className="task-list-subtitle">{listSubtitle}</p> : null}
            </div>
            <span className="plan-progress">
              {total > 0 ? Math.round((completed / total) * 100) : 0}%
            </span>
          </div>
          <div className="plan-capsule-body">
            <ul className="plan-steps-list">
              {sorted.map((task) => (
                <li key={task.id} className={`step-item status-${task.status}`}>
                  {getStatusIcon(task.status)}
                  <div className="step-info">
                    <span className="step-title">{task.subject}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
