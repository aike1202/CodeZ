import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import type { TaskData } from '../../stores/chatStore'
import './TaskPanel.css'

const SORT_ORDER: Record<TaskData['status'], number> = {
  in_progress: 0,
  pending: 1,
  completed: 3,
  cancelled: 4
}

const STATUS_ICON: Record<TaskData['status'], string> = {
  pending: '⬜',
  in_progress: '🔄',
  completed: '✅',
  cancelled: '❌'
}

const BLOCKED_ICON = '🔒'

function getSortKey(t: TaskData): number {
  // A pending task with unfinished blockers is shown in the "blocked" bucket.
  if (t.status === 'pending' && t.blockedBy.length > 0) return 2
  return SORT_ORDER[t.status] ?? 5
}

export const TaskPanel: React.FC = () => {
  const tasks = useChatStore((s) => s.tasks)
  const expandedCapsule = useChatStore((s) => s.expandedCapsule)
  const setExpandedCapsule = useChatStore((s) => s.setExpandedCapsule)

  if (tasks.length === 0) return null

  const completed = tasks.filter((t) => t.status === 'completed').length
  const total = tasks.length
  const hasUnfinished = tasks.some(
    (t) => t.status === 'in_progress' || t.status === 'pending'
  )

  const sorted = [...tasks].sort((a, b) => getSortKey(a) - getSortKey(b))
  const isExpanded = expandedCapsule === 'task'

  const capsuleClass = hasUnfinished ? 'task-capsule--unfinished' : 'task-capsule--done'
  const capsuleText = `▶ Tasks ${completed}/${total}`

  return (
    <div className="task-capsule-container">
      <button
        className={`task-capsule ${capsuleClass} ${isExpanded ? 'expanded' : ''}`}
        onClick={() => setExpandedCapsule(isExpanded ? null : 'task')}
        title="Toggle task panel"
        aria-expanded={isExpanded}
        aria-label={`Tasks ${completed} of ${total} completed`}
      >
        <span className="capsule-text">{capsuleText}</span>
      </button>

      {isExpanded && (
        <div className="task-panel" role="region" aria-label="Task list">
          <div className="task-panel-header">
            <span>
              Tasks {completed}/{total}
            </span>
            <button
              className="task-panel-collapse"
              onClick={() => setExpandedCapsule(null)}
            >
              ▲ collapse
            </button>
          </div>
          <div className="task-panel-list">
            {sorted.map((task) => {
              const blocked =
                task.status === 'pending' && task.blockedBy.length > 0
              const icon = blocked ? BLOCKED_ICON : STATUS_ICON[task.status]
              const isDone =
                task.status === 'completed' || task.status === 'cancelled'
              return (
                <div
                  key={task.id}
                  className={`task-row status-${task.status}${
                    task.status === 'in_progress' ? ' active' : ''
                  }`}
                >
                  <span className="task-status-icon" aria-hidden="true">
                    {icon}
                  </span>
                  <span
                    className={`task-subject${
                      isDone ? ' strikethrough' : ''
                    }${task.status === 'in_progress' ? ' in-progress' : ''}`}
                  >
                    {task.subject}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
