import React, { useEffect, useRef, useState } from 'react'
import type { ContextBudgetSnapshot } from '../../../shared/types/context'
import type { CompactionUiState } from '../stores/chatStore'
import Card from './ui/Card'
import Flex from './ui/Flex'

interface ContextTrackerProps {
  snapshot?: ContextBudgetSnapshot
  compactionState?: CompactionUiState
}

function formatTokens(tokens: number): string {
  const sign = tokens < 0 ? '-' : ''
  const absolute = Math.abs(tokens)
  if (absolute >= 1_000_000) return `${sign}${(absolute / 1_000_000).toFixed(1)}M`
  if (absolute >= 1_000) return `${sign}${(absolute / 1_000).toFixed(1)}k`
  return String(tokens)
}

const SOURCE_LABEL: Record<ContextBudgetSnapshot['estimateSource'], string> = {
  provider: 'Provider usage',
  tokenizer: 'Tokenizer',
  heuristic: '启发式估算'
}

export default function ContextTracker({ snapshot, compactionState }: ContextTrackerProps) {
  const [expanded, setExpanded] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const closeOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setExpanded(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => document.removeEventListener('mousedown', closeOutside)
  }, [])

  const usagePercent = snapshot
    ? (snapshot.totalInputTokens / Math.max(1, snapshot.usableInputBudget)) * 100
    : 0
  const barPercent = Math.min(100, usagePercent)
  const color = snapshot?.pressureLevel === 'overflow' || snapshot?.pressureLevel === 'compact'
    ? '#dc2626'
    : snapshot?.pressureLevel === 'prune'
      ? '#ea580c'
      : snapshot?.pressureLevel === 'warning'
        ? '#ca8a04'
        : '#2563eb'
  const radius = 6
  const circumference = 2 * Math.PI * radius

  const rows: Array<readonly [string, number, string]> = snapshot ? [
    ['System Prompt', snapshot.systemPromptTokens, '#2563eb'],
    ['工具定义', snapshot.toolSchemaTokens, '#059669'],
    ['规则与状态', snapshot.instructionTokens, '#7c3aed'],
    ['压缩摘要', snapshot.summaryTokens, '#d97706'],
    ['最近历史', snapshot.recentHistoryTokens, '#0891b2'],
    ['当前输入', snapshot.currentInputTokens, '#db2777'],
    ['协议开销', snapshot.protocolTokens, '#64748b']
  ] : []
  if (snapshot?.providerAdjustmentTokens) {
    rows.push(['Provider 校准', snapshot.providerAdjustmentTokens, '#475569'])
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        title={snapshot ? `上下文占用 ${usagePercent.toFixed(1)}%` : '上下文数据不可用'}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28,
          border: 'none', borderRadius: 4, cursor: 'pointer',
          background: expanded ? 'var(--bg-modifier-hover)' : 'transparent'
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="8" cy="8" r={radius} fill="none" stroke="var(--border-color)" strokeWidth="3" />
          {snapshot && barPercent > 0 && (
            <circle
              cx="8" cy="8" r={radius} fill="none" stroke={color} strokeWidth="3"
              strokeDasharray={circumference}
              strokeDashoffset={circumference - (barPercent / 100) * circumference}
              strokeLinecap="round"
            />
          )}
        </svg>
      </button>

      {expanded && (
        <Card variant="default" style={{
          position: 'absolute', bottom: '100%', right: 0, marginBottom: 8, width: 304,
          padding: 14, zIndex: 100, border: '1px solid var(--border-color)', borderRadius: 8,
          background: 'var(--bg-app, #fff)', boxShadow: '0 10px 25px -5px rgba(0,0,0,.3)'
        }}>
          {!snapshot ? (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>尚未收到主进程预算快照</span>
          ) : (
            <>
              <Flex align="center" justify="between" style={{ marginBottom: 10, fontSize: 12 }}>
                <span style={{ color: 'var(--text-muted)' }}>本轮模型输入</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {formatTokens(snapshot.totalInputTokens)} / {formatTokens(snapshot.usableInputBudget)} ({usagePercent.toFixed(1)}%)
                </span>
              </Flex>
              <div style={{ height: 6, borderRadius: 3, overflow: 'hidden', background: 'var(--bg-modifier-hover)', marginBottom: 12 }}>
                <div style={{ width: `${barPercent}%`, height: '100%', background: color }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {rows.map(([label, tokens, rowColor]) => (
                  <Flex key={label} align="center" justify="between" style={{ fontSize: 12 }}>
                    <Flex align="center" gap={2}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: rowColor }} />
                      <span>{label}</span>
                    </Flex>
                    <span style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{formatTokens(tokens)}</span>
                  </Flex>
                ))}
              </div>
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-color)', fontSize: 11, color: 'var(--text-muted)' }}>
                <Flex justify="between"><span>硬输入限制</span><span>{formatTokens(snapshot.hardInputLimit)}</span></Flex>
                <Flex justify="between"><span>输出预留</span><span>{formatTokens(snapshot.outputReserveTokens)}</span></Flex>
                <Flex justify="between"><span>安全边际</span><span>{formatTokens(snapshot.safetyMarginTokens)}</span></Flex>
                <Flex justify="between"><span>原始持久化历史</span><span>{formatTokens(snapshot.rawHistoryTokens)}</span></Flex>
                <Flex justify="between"><span>数据来源</span><span>{SOURCE_LABEL[snapshot.estimateSource]}</span></Flex>
                {compactionState?.status === 'running' && <div style={{ marginTop: 6, color: '#d97706' }}>正在压缩上下文</div>}
                {compactionState?.status === 'failed' && <div style={{ marginTop: 6, color: '#dc2626' }}>{compactionState.error || '压缩失败'}</div>}
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  )
}
