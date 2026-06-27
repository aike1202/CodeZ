import React, { useMemo, useState } from 'react'
import type { ToolCallState } from '../../stores/chatStore'
import Flex from '../ui/Flex'
import Stack from '../ui/Stack'
import { parseArgs } from '../../utils/parseArgs'
import './ToolCallLog.css'

type ToolVerb = {
  running: string
  success: string
  error: string
}

const TOOL_VERBS: Record<string, ToolVerb> = {
  list_files: {
    running: '正在查看目录',
    success: '已查看目录',
    error: '查看目录失败'
  },
  read_file: {
    running: '正在读取文件',
    success: '已读取文件',
    error: '读取文件失败'
  },
  search_text: {
    running: '正在搜索代码',
    success: '已搜索代码',
    error: '搜索代码失败'
  }
}

function getTarget(log: ToolCallState): string {
  const args = parseArgs(log.args)
  const value = args.path || args.filePath || args.directory || args.query || args.pattern || args.regex

  if (typeof value === 'string' && value.trim()) {
    return value
  }

  return ''
}

function getVerb(log: ToolCallState): string {
  const verbs = TOOL_VERBS[log.name] || {
    running: '正在使用工具',
    success: '已完成工具操作',
    error: '工具操作失败'
  }

  return verbs[log.status]
}

function formatToolArgs(args: string): string {
  if (!args.trim()) return '{}'

  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    return args
  }
}

function summarizeResult(result: string | undefined): string {
  if (!result) return ''
  return result.length > 220 ? `${result.slice(0, 220)}...` : result
}

function formatDuration(log: ToolCallState): string {
  if (!log.completedAt) return ''
  return `${Math.max(log.completedAt - log.startedAt, 1)}ms`
}

function getSummary(logs: ToolCallState[]): string {
  const running = logs.filter((log) => log.status === 'running').length
  const failed = logs.filter((log) => log.status === 'error').length
  const readCount = logs.filter((log) => log.name === 'read_file').length
  const listCount = logs.filter((log) => log.name === 'list_files').length
  const searchCount = logs.filter((log) => log.name === 'search_text').length

  if (running > 0) return `正在处理上下文，${running} 项进行中`

  const parts = [
    listCount > 0 ? `查看 ${listCount} 个目录` : '',
    readCount > 0 ? `读取 ${readCount} 个文件` : '',
    searchCount > 0 ? `搜索 ${searchCount} 次` : ''
  ].filter(Boolean)

  const prefix = parts.length > 0 ? parts.join('，') : `完成 ${logs.length} 项操作`
  return failed > 0 ? `${prefix}，${failed} 项失败` : prefix
}

function getVisibleLogs(logs: ToolCallState[], expanded: boolean): ToolCallState[] {
  const sortedLogs = [...logs].sort((a, b) => a.sequence - b.sequence || a.startedAt - b.startedAt)
  if (expanded || sortedLogs.length <= 3) return sortedLogs

  return sortedLogs.slice(-3)
}

export function ToolCallLog({ logs }: { logs?: ToolCallState[] }): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false)

  const sortedLogs = useMemo(
    () => logs ? [...logs].sort((a, b) => a.sequence - b.sequence || a.startedAt - b.startedAt) : [],
    [logs]
  )

  if (sortedLogs.length === 0) return null

  const visibleLogs = getVisibleLogs(sortedLogs, expanded)
  const hiddenCount = sortedLogs.length - visibleLogs.length
  const hasRunning = sortedLogs.some((log) => log.status === 'running')

  return (
    <div className="tool-log-container">
      <button
        type="button"
        className="tool-log-header-btn"
        onClick={() => setExpanded((value) => !value)}
      >
        <Flex align="center" justify="between" className="w-full">
          <Flex align="center" gap={2} className="min-w-0">
            <span className={`tool-log-status-pulse ${hasRunning ? 'running' : 'idle'}`} />
            <span className="truncate tool-log-summary-text">{getSummary(sortedLogs)}</span>
            <span className="tool-log-count-text">共 {sortedLogs.length} 项</span>
          </Flex>
          <span className="tool-log-expand-state-text">{expanded ? '收起' : '展开'}</span>
        </Flex>
      </button>

      {(expanded || hasRunning || sortedLogs.length <= 3) && (
        <Stack gap={1.5} className="tool-log-list-stack">
          {hiddenCount > 0 && (
            <button
              type="button"
              className="tool-log-earlier-btn"
              onClick={() => setExpanded(true)}
            >
              还有 {hiddenCount} 条较早记录
            </button>
          )}

          {visibleLogs.map((log) => {
            const target = getTarget(log)
            const result = summarizeResult(log.result)
            const duration = formatDuration(log)

            return (
              <details key={log.id} className="tool-log-detail-details" open={log.status === 'running' || log.status === 'error'}>
                <summary className="tool-log-detail-summary">
                  <Flex align="center" justify="between" className="w-full">
                    <Flex align="center" gap={2} className="min-w-0">
                      <span className={`tool-log-item-indicator-dot ${log.status === 'running' ? 'running' : log.status === 'error' ? 'error' : 'success'}`} />
                      <span className="tool-log-item-verb">{getVerb(log)}</span>
                      {target && <span className="tool-log-item-target">{target}</span>}
                    </Flex>
                    {duration && <span className="tool-log-item-duration">{duration}</span>}
                  </Flex>
                </summary>

                <Stack gap={1.5} className="tool-log-item-details-body">
                  <div>
                    <div className="tool-log-label-title">参数</div>
                    <pre className="tool-log-pre-args">{formatToolArgs(log.args)}</pre>
                  </div>

                  {result && (
                    <div>
                      <div className="tool-log-label-title">
                        {log.status === 'error' ? '错误' : '结果摘要'}
                      </div>
                      <pre className={`tool-log-pre-result ${log.status === 'error' ? 'error' : 'success'}`}>{result}</pre>
                    </div>
                  )}
                </Stack>
              </details>
            )
          })}
        </Stack>
      )}
    </div>
  )
}
