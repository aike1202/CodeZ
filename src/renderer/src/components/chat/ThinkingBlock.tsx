import React, { useState } from 'react'
import { IconChevron } from '../Icons'
import './ThinkingBlock.css'

export default function ThinkingBlock({
  reasoning,
  streaming
}: {
  reasoning?: string
  streaming?: boolean
}): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false)

  if (!reasoning && !streaming) return null

  if (!reasoning && streaming) {
    return (
      <div className="thinking-loading-wrapper">
        <span className="thinking-dot-container">
          <span className="thinking-dot-ping"></span>
          <span className="thinking-dot-core"></span>
        </span>
        正在思考...
      </div>
    )
  }

  return (
    <div className="thinking-block">
      <div 
        className="thinking-toggle-btn"
        onClick={() => setExpanded(!expanded)}
      >
        <IconChevron className={`thinking-chevron ${expanded ? 'is-expanded' : ''}`} />
        {streaming ? '正在思考...' : '已完成思考'}
      </div>
      
      {expanded && reasoning && (
        <div className="thinking-content">
          {reasoning}
          {streaming && <span className="streaming-cursor">▊</span>}
        </div>
      )}
    </div>
  )
}