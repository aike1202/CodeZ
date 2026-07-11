import React, { useState, useRef, useEffect } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { CircleDashed, Loader2, ListTodo, ChevronDown, ChevronUp } from 'lucide-react'
import type { TaskItem, TaskStatus } from '../../../../shared/types/task'
import { getTaskDisplayTasks } from './TaskCapsule.order'
import './TaskCapsule.css'

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

  const displayTasks = getTaskDisplayTasks(tasks || [])

  if (displayTasks.length === 0) {
    return null
  }

  const total = displayTasks.length
  const inProgress = displayTasks.find((t) => t.status === 'in_progress')

  // 从 tasks 里取第一个 TaskGroup 元数据作为清单头，兼容旧 title/subtitle
  const listTitle = displayTasks.find(t => t.groupTitle)?.groupTitle || displayTasks.find(t => t.title)?.title
  const listSubtitle = displayTasks.find(t => t.groupSubtitle)?.groupSubtitle || displayTasks.find(t => t.subtitle)?.subtitle
  const groupRisk = displayTasks.find(t => t.riskLevel)?.riskLevel
  const approvalStatus = displayTasks.find(t => t.approvalStatus)?.approvalStatus
  const requiresApproval = displayTasks.some(t => t.requiresApproval)

  const getStatusIcon = (status: TaskStatus) => {
    return status === 'in_progress'
      ? <Loader2 className="step-icon in-progress spin" size={14} />
      : <CircleDashed className="step-icon pending" size={14} />
  }

  const headText = (task: TaskItem) => task.activeForm || task.subject

  return (
    <div className={`plan-capsule-wrapper task-capsule-wrapper ${expanded ? 'expanded' : ''}`} ref={capsuleRef}>
      <div className="plan-capsule executing" onClick={() => setExpanded(!expanded)}>
        <ListTodo className="plan-capsule-icon" size={14} />
        <span className="plan-capsule-text">
          {inProgress ? headText(inProgress) : `Tasks ${total}`}
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
              剩余 {total}
            </span>
          </div>
          <div className="plan-capsule-body">
            <ul className="plan-steps-list">
              {displayTasks.map((task) => (
                <li key={task.id} className={`step-item status-${task.status}`}>
                  {getStatusIcon(task.status)}
                  <div className="step-info">
                    <span className="step-title">{task.subject}</span>
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
