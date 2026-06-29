import React, { useState, useMemo, useRef, useEffect } from 'react'
import Card from './ui/Card'
import Flex from './ui/Flex'
import { ChatMessage } from '../stores/chatStore'

interface ContextTrackerProps {
  messages: ChatMessage[]
  maxContextTokens: number
  skillsCount?: number
}

function formatTokens(t: number) {
  if (t >= 1000000) return `${(t / 1000000).toFixed(1)}M`
  if (t >= 1000) return `${(t / 1000).toFixed(1)}k`
  return t.toString()
}

function estimate(text: string): number {
  if (!text) return 0
  const cjkMatches = text.match(/[\u3400-\u9FBF]/g)
  const cjkCount = cjkMatches ? cjkMatches.length : 0
  const otherCount = text.length - cjkCount
  return Math.ceil(cjkCount / 1.5 + otherCount / 4)
}

export default function ContextTracker({ messages, maxContextTokens, skillsCount = 0 }: ContextTrackerProps) {
  const [expanded, setExpanded] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setExpanded(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const breakdown = useMemo(() => {
    // 自动修正用户输入的小数值，例如输入 20 代表 20万
    const effectiveMax = maxContextTokens < 1000 && maxContextTokens > 0 
      ? maxContextTokens * 10000 
      : Math.max(1, maxContextTokens)

    const systemTools = 2000 // 更合理的预估值
    const systemPrompt = 1000 // 基础 Prompt 预估
    const skills = skillsCount * 500 // 技能预估
    
    const messagesTokens = messages.reduce((acc, m) => {
       let c = m.content || ''
       if (m.reasoningContent) c += m.reasoningContent
       const txt = typeof c === 'string' ? c : JSON.stringify(c)
       return acc + estimate(txt)
    }, 0)

    const totalUsed = systemTools + systemPrompt + skills + messagesTokens
    const freeSpace = Math.max(0, effectiveMax - totalUsed)

    return {
      systemTools,
      systemPrompt,
      skills,
      messages: messagesTokens,
      totalUsed,
      freeSpace,
      effectiveMax
    }
  }, [messages, maxContextTokens, skillsCount])

  const totalPercent = Math.min((breakdown.totalUsed / breakdown.effectiveMax) * 100, 100)
  
  // Pie chart gradient calculation
  const p1 = (breakdown.systemTools / breakdown.effectiveMax) * 100
  const p2 = p1 + (breakdown.systemPrompt / breakdown.effectiveMax) * 100
  const p3 = p2 + (breakdown.messages / breakdown.effectiveMax) * 100
  const p4 = p3 + (breakdown.skills / breakdown.effectiveMax) * 100

  const pieGradient = `conic-gradient(
    #2563eb 0% ${p1}%, 
    #3b82f6 ${p1}% ${p2}%, 
    #60a5fa ${p2}% ${p3}%, 
    #93c5fd ${p3}% ${p4}%, 
    var(--bg-modifier-hover) ${p4}% 100%
  )`

  const closedRingColor = totalPercent > 90 ? '#ef4444' : totalPercent > 75 ? '#fb923c' : '#3b82f6'
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const strokeDashoffset = circumference - (totalPercent / 100) * circumference

  const renderBreakdownItem = (label: string, tokens: number, color: string) => {
    const percent = Math.min((tokens / breakdown.effectiveMax) * 100, 100)
    return (
      <Flex justify="between" align="center" style={{ padding: '4px 0', fontSize: '12px' }}>
        <Flex align="center" gap={2}>
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: color }} />
          <span style={{ color: 'var(--text-normal)' }}>{label}</span>
        </Flex>
        <Flex gap={3} style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>
          <span style={{ width: '48px', textAlign: 'right' }}>{formatTokens(tokens)}</span>
          <span style={{ width: '40px', textAlign: 'right', color: 'var(--text-normal)' }}>{percent.toFixed(1)}%</span>
        </Flex>
      </Flex>
    )
  }

  return (
    <div style={{ position: 'relative' }} ref={containerRef}>
      {/* Closed State UI: 环形进度条 */}
      <button 
        type="button"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '28px',
          height: '28px',
          borderRadius: '4px',
          background: expanded ? 'var(--bg-modifier-hover)' : 'transparent',
          border: 'none',
          cursor: 'pointer',
          transition: 'background 0.2s'
        }}
        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-modifier-hover)'}
        onMouseLeave={(e) => e.currentTarget.style.background = expanded ? 'var(--bg-modifier-hover)' : 'transparent'}
        onClick={() => setExpanded(!expanded)}
        title={`上下文占用: ${totalPercent.toFixed(1)}%`}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" style={{ transform: 'rotate(-90deg)' }}>
          <circle
            cx="8" cy="8" r={radius}
            fill="none"
            stroke="var(--border-color)"
            strokeWidth="3"
          />
          {totalPercent > 0 && (
            <circle
              cx="8" cy="8" r={radius}
              fill="none"
              stroke={closedRingColor}
              strokeWidth="3"
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="round"
            />
          )}
        </svg>
      </button>

      {/* Expanded Popover */}
      {expanded && (
        <Card 
          variant="default" 
          style={{
            position: 'absolute',
            bottom: '100%',
            marginBottom: '8px',
            right: 0,
            padding: '16px',
            width: '288px',
            zIndex: 100,
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.3)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            background: 'var(--bg-app, #ffffff)' // 强制使用完全不透明的主应用背景色
          }}
        >
          <Flex align="center" justify="between" style={{ marginBottom: '12px', fontSize: '13px', color: 'var(--text-muted)' }}>
            <span>上下文容量</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {formatTokens(breakdown.totalUsed)} / {formatTokens(breakdown.effectiveMax)} ({totalPercent.toFixed(1)}%)
            </span>
          </Flex>

          <div style={{ width: '100%', background: 'var(--bg-modifier-hover)', borderRadius: '999px', height: '6px', overflow: 'hidden', marginBottom: '16px', display: 'flex' }}>
            <div style={{ height: '100%', background: '#2563eb', width: `${(breakdown.systemTools / breakdown.effectiveMax) * 100}%` }} />
            <div style={{ height: '100%', background: '#3b82f6', width: `${(breakdown.systemPrompt / breakdown.effectiveMax) * 100}%` }} />
            <div style={{ height: '100%', background: '#60a5fa', width: `${(breakdown.messages / breakdown.effectiveMax) * 100}%` }} />
            <div style={{ height: '100%', background: '#93c5fd', width: `${(breakdown.skills / breakdown.effectiveMax) * 100}%` }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {renderBreakdownItem('系统工具', breakdown.systemTools, '#2563eb')}
            {renderBreakdownItem('系统预设', breakdown.systemPrompt, '#3b82f6')}
            {renderBreakdownItem('对话消息', breakdown.messages, '#60a5fa')}
            {renderBreakdownItem('加载技能', breakdown.skills, '#93c5fd')}
            {renderBreakdownItem('剩余空间', breakdown.freeSpace, 'var(--bg-modifier-hover)')}
          </div>
        </Card>
      )}
    </div>
  )
}
