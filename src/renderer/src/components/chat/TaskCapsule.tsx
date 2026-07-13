import React, { useRef, useEffect } from 'react'
import { useChatStore } from '../../stores/chatStore'
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleDashed,
  GitMerge,
  ListTodo,
  Loader2,
  Pause,
  UserCheck,
  XCircle,
} from 'lucide-react'
import type { TaskItem } from '../../../../shared/types/task'
import { getRemainingTaskCount, getTaskDisplayTasks } from './TaskCapsule.order'
import {
  getTaskDisplayStatus,
  getTaskStatusLabel,
  isTaskDisplayActive,
  type TaskDisplayStatus,
} from './TaskCapsule.status'
import './TaskCapsule.css'

const TASK_ICON_PROPS = { size: 18, strokeWidth: 2.25, 'aria-hidden': true as const }

function TaskStatusIcon({ status }: { status: TaskDisplayStatus }): React.ReactElement {
  switch (status) {
    case 'running':
    case 'in_progress':
    case 'stopping':
    case 'integrating':
      return <Loader2 className={`step-icon ${status} spin`} {...TASK_ICON_PROPS} />
    case 'paused':
      return <Pause className="step-icon paused" {...TASK_ICON_PROPS} />
    case 'succeeded':
      return <GitMerge className="step-icon succeeded" {...TASK_ICON_PROPS} />
    case 'completed':
      return <CheckCircle2 className="step-icon completed" {...TASK_ICON_PROPS} />
    case 'failed':
    case 'interrupted':
    case 'lost':
      return <CircleAlert className={`step-icon ${status}`} {...TASK_ICON_PROPS} />
    case 'taken_over':
      return <UserCheck className="step-icon taken-over" {...TASK_ICON_PROPS} />
    case 'stopped':
    case 'cancelled':
      return <XCircle className={`step-icon ${status}`} {...TASK_ICON_PROPS} />
    case 'pending':
    case 'queued':
      return <CircleDashed className="step-icon pending" {...TASK_ICON_PROPS} />
  }
}

const getHeadText = (task: TaskItem): string => task.activeForm || task.subject

export const TaskCapsule: React.FC = () => {
  const tasks = useChatStore((s) => s.tasks)
  const expandedCapsule = useChatStore((s) => s.expandedCapsule)
  const setExpandedCapsule = useChatStore((s) => s.setExpandedCapsule)
  const expanded = expandedCapsule === 'task'
  const capsuleRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (expanded && capsuleRef.current && !capsuleRef.current.contains(event.target as Node)) {
        setExpandedCapsule(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [expanded, setExpandedCapsule])

  const displayTasks = getTaskDisplayTasks(tasks || [])

  if (displayTasks.length === 0) {
    return null
  }

  const remaining = getRemainingTaskCount(displayTasks)
  const taskViews = displayTasks.map(task => ({ task, displayStatus: getTaskDisplayStatus(task) }))
  const activeTasks = taskViews.filter(({ displayStatus }) => isTaskDisplayActive(displayStatus))

  // 从 tasks 里取第一个 TaskGroup 元数据作为清单头，兼容旧 title/subtitle
  const listTitle = displayTasks.find(t => t.groupTitle)?.groupTitle || displayTasks.find(t => t.title)?.title
  const listSubtitle = displayTasks.find(t => t.groupSubtitle)?.groupSubtitle || displayTasks.find(t => t.subtitle)?.subtitle
  const groupRisk = displayTasks.find(t => t.riskLevel)?.riskLevel
  const approvalStatus = displayTasks.find(t => t.approvalStatus)?.approvalStatus
  const requiresApproval = displayTasks.some(t => t.requiresApproval)

  return (
    <div className={`plan-capsule-wrapper task-capsule-wrapper ${expanded ? 'expanded' : ''}`} ref={capsuleRef}>
      <div
        className="plan-capsule executing"
        onClick={() => setExpandedCapsule(expanded ? null : 'task')}
      >
        <ListTodo className="plan-capsule-icon" size={14} />
        <span className="plan-capsule-text">
          {activeTasks.length > 1
            ? `${activeTasks.length} 项任务执行中`
            : activeTasks.length === 1
              ? getHeadText(activeTasks[0].task)
              : `任务 ${displayTasks.length}`}
        </span>
        {expanded ? <ChevronUp size={14} className="chevron" /> : <ChevronDown size={14} className="chevron" />}
      </div>

      {expanded && (
        <div className="plan-capsule-popover">
          <div className="plan-capsule-header">
            <div>
              {listTitle ? <h4>{listTitle}</h4> : <h4>任务清单</h4>}
              {listSubtitle ? <p className="task-list-subtitle">{listSubtitle}</p> : null}
              {(groupRisk || requiresApproval) ? (
                <p className="task-list-subtitle">
                  {groupRisk ? `风险: ${groupRisk}` : null}
                  {groupRisk && requiresApproval ? ' · ' : null}
                  {requiresApproval ? `审批: ${approvalStatus || 'pending'}` : null}
                </p>
              ) : null}
            </div>
            <span className="plan-progress">
              剩余 {remaining}
            </span>
          </div>
          <div className="plan-capsule-body">
            <ul className="plan-steps-list">
              {taskViews.map(({ task, displayStatus }) => (
                <li key={task.id} className={`step-item status-${displayStatus}`}>
                  <TaskStatusIcon status={displayStatus} />
                  <div className="step-info">
                    <div className="task-step-title-row">
                      <span className="step-title">{task.subject}</span>
                      <span
                        className={`task-status-label status-${displayStatus}`}
                        title={task.executorRuntime?.error}
                      >
                        {getTaskStatusLabel(displayStatus)}
                      </span>
                    </div>
                    {task.acceptanceCriteria && task.acceptanceCriteria.length > 0 ? (
                      <span className="step-desc">{task.acceptanceCriteria.join(' / ')}</span>
                    ) : null}
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
