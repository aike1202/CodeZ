import React, { useRef, useEffect } from 'react'
import { useChatStore } from '../../stores/chatStore'
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleDashed,
  ListTodo,
  Loader2,
  XCircle,
} from 'lucide-react'
import type { TodoItem } from '../../../../shared/types/todo'
import { getRemainingTodoCount, getTodoDisplayItems } from './TodoCapsule.order'
import {
  getTodoBlockReason,
  getTodoDisplayStatus,
  getTodoStatusLabel,
  isTodoDisplayActive,
  type TodoDisplayStatus,
} from './TodoCapsule.status'
import './TodoCapsule.css'

const TODO_ICON_PROPS = { size: 18, strokeWidth: 2.25, 'aria-hidden': true as const }

function TodoStatusIcon({ status }: { status: TodoDisplayStatus }): React.ReactElement {
  switch (status) {
    case 'in_progress':
      return <Loader2 className={`step-icon ${status} spin`} {...TODO_ICON_PROPS} />
    case 'completed':
      return <CheckCircle2 className="step-icon completed" {...TODO_ICON_PROPS} />
    case 'blocked':
      return <CircleAlert className={`step-icon ${status}`} {...TODO_ICON_PROPS} />
    case 'cancelled':
      return <XCircle className={`step-icon ${status}`} {...TODO_ICON_PROPS} />
    case 'pending':
      return <CircleDashed className="step-icon pending" {...TODO_ICON_PROPS} />
  }
}

const getHeadText = (todo: TodoItem): string => todo.activeForm || todo.subject

export const TodoCapsule: React.FC = () => {
  const todos = useChatStore((s) => s.todos)
  const expandedCapsule = useChatStore((s) => s.expandedCapsule)
  const setExpandedCapsule = useChatStore((s) => s.setExpandedCapsule)
  const expanded = expandedCapsule === 'todo'
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

  const displayTodos = getTodoDisplayItems(todos || [])

  if (displayTodos.length === 0) {
    return null
  }

  const remaining = getRemainingTodoCount(displayTodos)
  const todoViews = displayTodos.map(todo => ({
    todo,
    displayStatus: getTodoDisplayStatus(todo, displayTodos),
    blockReason: getTodoBlockReason(todo, displayTodos),
  }))
  const activeTodos = todoViews.filter(({ displayStatus }) => isTodoDisplayActive(displayStatus))

  // 从 todos 里取第一个 Todo group 元数据作为清单头，兼容旧 title/subtitle
  const listTitle = displayTodos.find(t => t.groupTitle)?.groupTitle || displayTodos.find(t => t.title)?.title
  const listSubtitle = displayTodos.find(t => t.groupSubtitle)?.groupSubtitle || displayTodos.find(t => t.subtitle)?.subtitle
  const groupRisk = displayTodos.find(t => t.riskLevel)?.riskLevel
  const approvalStatus = displayTodos.find(t => t.approvalStatus)?.approvalStatus
  const requiresApproval = displayTodos.some(t => t.requiresApproval)

  return (
    <div className={`plan-capsule-wrapper todo-capsule-wrapper ${expanded ? 'expanded' : ''}`} ref={capsuleRef}>
      <div
        className="plan-capsule executing"
        onClick={() => setExpandedCapsule(expanded ? null : 'todo')}
      >
        <ListTodo className="plan-capsule-icon" size={14} />
        <span className="plan-capsule-text">
          {activeTodos.length > 1
            ? `${activeTodos.length} 项任务执行中`
            : activeTodos.length === 1
              ? getHeadText(activeTodos[0].todo)
              : `任务 ${displayTodos.length}`}
        </span>
        {expanded ? <ChevronUp size={14} className="chevron" /> : <ChevronDown size={14} className="chevron" />}
      </div>

      {expanded && (
        <div className="plan-capsule-popover">
          <div className="plan-capsule-header">
            <div>
              {listTitle ? <h4>{listTitle}</h4> : <h4>任务清单</h4>}
              {listSubtitle ? <p className="todo-list-subtitle">{listSubtitle}</p> : null}
              {(groupRisk || requiresApproval) ? (
                <p className="todo-list-subtitle">
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
              {todoViews.map(({ todo, displayStatus, blockReason }) => (
                <li key={todo.id} className={`step-item status-${displayStatus}`}>
                  <TodoStatusIcon status={displayStatus} />
                  <div className="step-info">
                    <div className="todo-step-title-row">
                      <span className="step-title">{todo.subject}</span>
                      <span
                        className={`todo-status-label status-${displayStatus}`}
                        title={blockReason}
                      >
                        {getTodoStatusLabel(displayStatus)}
                      </span>
                    </div>
                    {blockReason ? (
                      <span className="step-desc todo-block-reason">{blockReason}</span>
                    ) : todo.acceptanceCriteria && todo.acceptanceCriteria.length > 0 ? (
                      <span className="step-desc">{todo.acceptanceCriteria.join(' / ')}</span>
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
