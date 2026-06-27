import React from 'react'
import type { AgentState } from '../../stores/chatStore'
import { IconLoading, IconCheckCircle, IconSearch, IconEdit, IconTodo } from '../Icons'
import './AgentStateTimeline.css'

export default function AgentStateTimeline({ states }: { states?: AgentState[] }): React.ReactElement | null {
  if (!states || states.length === 0) return null

  return (
    <div className="timeline-container">
      {states.map((state) => {
        switch (state.type) {
          case 'processing':
            return (
              <div key={state.id} className="timeline-processing">
                {state.title}
              </div>
            )
          case 'command_running':
            return (
              <div key={state.id} className="timeline-command-running">
                <IconLoading className="timeline-loading-icon" />
                <span className="timeline-command-title">{state.title}</span>
              </div>
            )
          case 'command_completed':
            return (
              <div key={state.id} className="timeline-command-completed">
                <IconCheckCircle className="timeline-icon-hidden" />
                <span className="timeline-command-title">{state.title}</span>
              </div>
            )
          case 'exploration':
            return (
              <div key={state.id} className="timeline-exploration">
                <IconSearch className="timeline-icon-shrink" />
                <span>{state.title}</span>
              </div>
            )
          case 'edit':
            return (
              <div key={state.id} className="timeline-edit">
                <IconEdit className="timeline-edit-icon" />
                <span className="timeline-edit-title">{state.title}</span>
                {state.detail && (
                  <span className="timeline-edit-detail">
                    {state.detail.includes('+') && <span className="timeline-detail-add">{state.detail.split(' ')[0]}</span>}
                    {state.detail.includes('-') && <span className="timeline-detail-del">{state.detail.split(' ')[1]}</span>}
                  </span>
                )}
              </div>
            )
          case 'todo':
            return (
              <div key={state.id} className="timeline-todo">
                <IconTodo />
                <span>{state.title}</span>
                {state.detail && <span className="timeline-todo-detail">{state.detail}</span>}
              </div>
            )
          default:
            return null
        }
      })}
    </div>
  )
}