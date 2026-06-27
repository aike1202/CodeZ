import React, { useMemo, useState, useEffect } from 'react'
import type { AgentState, ExecutionTimelineItem, ToolCallState } from '../../stores/chatStore'
import Flex from '../ui/Flex'
import Stack from '../ui/Stack'
import IconLoading from '../icons/IconLoading'
import IconCheck from '../icons/IconCheck'
import IconChevron from '../icons/IconChevron'
import { parseArgs } from '../../utils/parseArgs'
import {
  type UnifiedTimelineItem,
  buildFallbackTimeline,
  buildCommandItems,
  buildEditItems,
  buildUnifiedTimeline,
  buildSummaryText,
  getFileIconComponent
} from './ExecutionLogUtils'
import ExecutionLogDetail from './ExecutionLogDetail'
import {
  FileIcon,
  FolderIcon,
  ThoughtIcon,
  SearchIcon,
  CmdIcon
} from '../svg-icons'
import './ExecutionLog.css'

export default function ExecutionLog({
  timeline,
  reasoning,
  agentStates,
  onFileClick,
  onDiffClick,
  streaming
}: {
  timeline?: ExecutionTimelineItem[]
  reasoning?: string
  agentStates?: AgentState[]
  onFileClick?: (filePath: string, virtualContent?: string) => void
  onDiffClick?: (
    filePath: string,
    editInfo: {
      type: 'write' | 'replace'
      targetContent?: string
      replacementContent?: string
      codeContent?: string
    }
  ) => void
  streaming?: boolean
}): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false)
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({})

  const normalizedTimeline = useMemo(() => buildFallbackTimeline(timeline, reasoning), [timeline, reasoning])
  const commands = useMemo(() => buildCommandItems(agentStates || []), [agentStates])
  const edits = useMemo(() => buildEditItems(agentStates || []), [agentStates])

  const unifiedItems = useMemo(
    () => buildUnifiedTimeline(normalizedTimeline, commands, edits, reasoning, streaming),
    [normalizedTimeline, commands, edits, reasoning, streaming]
  )

  const running = useMemo(() => {
    return Boolean(streaming) || unifiedItems.some((item) => item.status === 'running')
  }, [unifiedItems, streaming])

  useEffect(() => {
    if (running) {
      setExpanded(true)
    } else {
      setExpanded(false)
    }
  }, [running])

  const lastReasoningItem = useMemo(() => {
    for (let i = unifiedItems.length - 1; i >= 0; i--) {
      if (unifiedItems[i].type === 'reasoning') {
        return unifiedItems[i]
      }
    }
    return null
  }, [unifiedItems])

  const lastReasoningId = lastReasoningItem?.id || ''
  const lastReasoningStatus = lastReasoningItem?.status || ''
  const itemsCount = unifiedItems.length

  useEffect(() => {
    if (itemsCount === 0) return

    setExpandedMap((prev) => {
      const next: Record<string, boolean> = { ...prev }
      
      unifiedItems.forEach((item) => {
        const isLatestReasoning = lastReasoningItem && item.id === lastReasoningItem.id
        if (isLatestReasoning && item.status === 'running') {
          next[item.id] = true
        } else {
          next[item.id] = false
        }
      })

      return next
    })
  }, [lastReasoningId, lastReasoningStatus, itemsCount])

  if (unifiedItems.length === 0) return null

  const summary = buildSummaryText(unifiedItems, running)

  const getItemIcon = (item: UnifiedTimelineItem) => {
    if (item.type === 'reasoning') {
      return <ThoughtIcon running={item.status === 'running'} />
    }
    if (item.type === 'command') {
      return <CmdIcon />
    }
    if (item.type === 'edit') {
      return getFileIconComponent(item.fileName)
    }
    if (item.type === 'tool') {
      if (item.verb === 'Searched') {
        return <SearchIcon />
      }
      if (item.verb === 'Explored') {
        return <FolderIcon />
      }
      return getFileIconComponent(item.fileName)
    }
    return <FileIcon />
  }

  const hasDetail = (item: UnifiedTimelineItem) => {
    const isFileItem = item.type === 'edit' || (item.type === 'tool' && item.verb === 'Analyzed' && item.fileName)
    if (isFileItem) return false

    if (item.type === 'reasoning') {
      return !!item.detail?.trim()
    }
    if (item.type === 'tool') {
      return !!item.args || !!item.detail
    }
    if (item.type === 'command') {
      return !!(item.detail && item.status !== 'running')
    }
    return false
  }

  const toggleItemExpand = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setExpandedMap((prev) => ({
      ...prev,
      [id]: !prev[id]
    }))
  }

  return (
    <div className="mb-4 timeline-container">
      <button
        type="button"
        className="timeline-header-btn"
        onClick={() => setExpanded((val) => !val)}
      >
        <Flex align="center" gap={2} className="timeline-header-text">
          {running ? (
            <IconLoading width="12" height="12" className="spin-slow" />
          ) : (
            <IconCheck width="12" height="12" className="timeline-icon-success" style={{ color: 'var(--text-success, #059669)' }} />
          )}
          <span>{summary}</span>
        </Flex>
        <span className="timeline-header-arrow-text">
          {expanded ? 'Collapse' : 'Expand'}
        </span>
      </button>

      {expanded && (
        <Stack className="timeline-list">
          {unifiedItems.map((item, idx) => {
            const isLast = idx === unifiedItems.length - 1
            const hasItemDetail = hasDetail(item)
            const isItemExpanded = expandedMap[item.id]
            const isSnapshotItem = item.type === 'tool' && (item.toolName === 'get_project_snapshot' || item.target === '项目快照')
            const isFileItem =
              item.type === 'edit' ||
              (item.type === 'tool' &&
                item.verb === 'Analyzed' &&
                (item.fileName || isSnapshotItem))

            return (
              <Stack key={item.id} className="timeline-item-wrapper">
                {!isLast && (
                  <div className="timeline-line-indicator" />
                )}

                {item.type === 'text' ? (
                  <Flex align="start" gap={2} className="timeline-detail-status-line">
                    <span className="timeline-detail-working-badge animate-pulse">Working</span>
                    <span className="whitespace-pre-wrap break-all min-w-0">{(item as any).content || item.detail}</span>
                  </Flex>
                ) : (
                  <>
                    <Flex
                      align="center"
                      justify="between"
                      className={`timeline-item-row ${
                        hasItemDetail ? 'interactive' : ''
                      }`}
                      onClick={(e) => hasItemDetail && toggleItemExpand(item.id, e)}
                    >
                      <Flex align="center" gap={2} className="min-w-0 relative">
                        <span className="timeline-icon-box">
                          {getItemIcon(item)}
                        </span>

                        <span className="truncate pr-4">
                          <span
                            className={`timeline-verb-text timeline-verb-${item.verb.toLowerCase()}`}
                            title={item.toolName ? `调用工具: ${item.toolName}` : undefined}
                          >
                            {item.verb}
                          </span>
                          {isFileItem ? (
                            <span
                              className="timeline-target-link"
                              onClick={(e) => {
                                e.stopPropagation()
                                if (item.type === 'edit') {
                                  const argsObj = parseArgs(item.args || '')
                                  if (item.verb === 'Created' || item.verb === 'Creating') {
                                    onDiffClick?.(item.target, {
                                      type: 'write',
                                      codeContent: argsObj.codeContent || argsObj.code_content || ''
                                    })
                                  } else if (item.verb === 'Edited' || item.verb === 'Editing') {
                                    if (item.toolName === 'multi_replace_file_content') {
                                      const chunks = Array.isArray(argsObj.ReplacementChunks) ? argsObj.ReplacementChunks : (Array.isArray(argsObj.replacementChunks) ? argsObj.replacementChunks : [])
                                      const targetContent = chunks.map((c: any, i: number) => `--- Chunk ${i + 1} ---\n${c.TargetContent || c.targetContent || ''}`).join('\n\n')
                                      const replacementContent = chunks.map((c: any, i: number) => `--- Chunk ${i + 1} ---\n${c.ReplacementContent || c.replacementContent || ''}`).join('\n\n')
                                      onDiffClick?.(item.target, {
                                        type: 'replace',
                                        targetContent,
                                        replacementContent
                                      })
                                    } else {
                                      onDiffClick?.(item.target, {
                                        type: 'replace',
                                        targetContent: argsObj.targetContent || '',
                                        replacementContent: argsObj.replacementContent || ''
                                      })
                                    }
                                  }
                                } else if (isSnapshotItem) {
                                  let markdownContent = ''
                                  try {
                                    const parsed = item.detail ? JSON.parse(item.detail) : null
                                    if (parsed && typeof parsed === 'object') {
                                      const parts: string[] = []
                                      parts.push(`# 项目快照\n`)
                                      parts.push(`- **根目录**: \`${parsed.rootPath || '-'}\``)
                                      parts.push(`- **项目类型**: \`${parsed.projectType || '-'}\``)
                                      parts.push(`- **包管理器**: \`${parsed.packageManager || '-'}\``)
                                      parts.push(`- **生成时间**: \`${parsed.updatedAt || '-'}\` ${parsed.fromCache ? '(缓存命中)' : ''}\n`)

                                      if (parsed.scripts && Object.keys(parsed.scripts).length > 0) {
                                        parts.push(`### 项目内置脚本`)
                                        for (const [name, cmd] of Object.entries(parsed.scripts)) {
                                          parts.push(`- \`${name}\`: \`${cmd}\``)
                                        }
                                        parts.push('')
                                      }

                                      if (parsed.dependencies && Object.keys(parsed.dependencies).length > 0) {
                                        parts.push(`### 依赖列表 (Dependencies)`)
                                        parts.push('| 依赖库 | 版本 |')
                                        parts.push('| :--- | :--- |')
                                        for (const [dep, version] of Object.entries(parsed.dependencies)) {
                                          parts.push(`| \`${dep}\` | \`${version}\` |`)
                                        }
                                        parts.push('')
                                      }

                                      if (parsed.devDependencies && Object.keys(parsed.devDependencies).length > 0) {
                                        parts.push(`### 开发依赖 (Dev Dependencies)`)
                                        parts.push('| 依赖库 | 版本 |')
                                        parts.push('| :--- | :--- |')
                                        for (const [dep, version] of Object.entries(parsed.devDependencies)) {
                                          parts.push(`| \`${dep}\` | \`${version}\` |`)
                                        }
                                        parts.push('')
                                      }

                                      if (Array.isArray(parsed.configFiles) && parsed.configFiles.length > 0) {
                                        parts.push(`### 配置文件`)
                                        parts.push(parsed.configFiles.map((f: any) => `- \`${f}\``).join('\n'))
                                        parts.push('')
                                      }

                                      if (Array.isArray(parsed.entrypoints) && parsed.entrypoints.length > 0) {
                                        parts.push(`### 入口文件`)
                                        parts.push(parsed.entrypoints.map((f: any) => `- \`${f}\``).join('\n'))
                                        parts.push('')
                                      }

                                      if (Array.isArray(parsed.recommendedFiles) && parsed.recommendedFiles.length > 0) {
                                        parts.push(`### 推荐阅读文件`)
                                        parts.push(parsed.recommendedFiles.map((f: any) => `- \`${f}\``).join('\n'))
                                        parts.push('')
                                      }

                                      if (parsed.tree) {
                                        parts.push(`### 目录结构树`)
                                        parts.push('```text')
                                        parts.push(parsed.tree)
                                        parts.push('```')
                                      }

                                      markdownContent = parts.join('\n')
                                    } else {
                                      markdownContent = item.detail || '无快照内容'
                                    }
                                  } catch {
                                    markdownContent = item.detail || '快照解析失败'
                                  }
                                  onFileClick?.('项目快照.md', markdownContent)
                                } else {
                                  onFileClick?.(item.realPath || item.target)
                                }
                              }}
                              title={item.type === 'edit' ? '点击查看修改 Diff' : isSnapshotItem ? '点击在右侧打开项目快照预览' : `点击在右侧打开预览 ${item.realPath || item.target}`}
                            >
                              {item.target}
                            </span>
                          ) : item.type === 'command' ? (
                            <>
                              <code className="timeline-cmd-code">{item.target}</code>
                              {item.status !== 'running' && (
                                <span className={`timeline-cmd-status-badge ${
                                  item.status === 'error' ? 'failed' : 'success'
                                }`}>
                                  {item.status === 'error' ? 'Failed' : 'Success'}
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="timeline-target-link" style={{ textDecoration: 'none', cursor: 'default' }}>{item.target}</span>
                          )}
                          {item.type === 'edit' && (
                            <span
                              className="timeline-edit-diff-link"
                              title="点击查看修改 Diff"
                              onClick={(e) => {
                                e.stopPropagation()
                                const argsObj = parseArgs(item.args || '')
                                if (item.verb === 'Created' || item.verb === 'Creating') {
                                  onDiffClick?.(item.target, {
                                    type: 'write',
                                    codeContent: argsObj.codeContent || argsObj.code_content || ''
                                  })
                                } else if (item.verb === 'Edited' || item.verb === 'Editing') {
                                  if (item.toolName === 'multi_replace_file_content') {
                                    const chunks = Array.isArray(argsObj.ReplacementChunks) ? argsObj.ReplacementChunks : (Array.isArray(argsObj.replacementChunks) ? argsObj.replacementChunks : [])
                                    const targetContent = chunks.map((c: any, i: number) => `--- Chunk ${i + 1} ---\n${c.TargetContent || c.targetContent || ''}`).join('\n\n')
                                    const replacementContent = chunks.map((c: any, i: number) => `--- Chunk ${i + 1} ---\n${c.ReplacementContent || c.replacementContent || ''}`).join('\n\n')
                                    onDiffClick?.(item.target, {
                                      type: 'replace',
                                      targetContent,
                                      replacementContent
                                    })
                                  } else {
                                    onDiffClick?.(item.target, {
                                      type: 'replace',
                                      targetContent: argsObj.targetContent || '',
                                      replacementContent: argsObj.replacementContent || ''
                                    })
                                  }
                                }
                              }}
                            >
                              <span className="timeline-diff-add">+{item.additions}</span>
                              <span style={{ margin: '0 2px', color: 'var(--text-light, #d1d5db)' }}>/</span>
                              <span className="timeline-diff-del">-{item.deletions}</span>
                            </span>
                          )}
                        </span>
                      </Flex>

                      <Flex align="center" gap={2} className="shrink-0">
                        {item.status === 'running' ? (
                          <span className="timeline-item-running-dot-box">
                            <span className="timeline-item-running-dot-pulse animate-ping"></span>
                            <span className="timeline-item-running-dot"></span>
                          </span>
                        ) : (
                          hasItemDetail && (
                            <IconChevron 
                              width="11" 
                              height="11" 
                              className={`timeline-expand-arrow ${
                                isItemExpanded ? 'expanded' : ''
                              }`} 
                            />
                          )
                        )}
                      </Flex>
                    </Flex>

                    {isItemExpanded && hasItemDetail && (
                      <div className="timeline-item-detail-box">
                        <ExecutionLogDetail item={item} onFileClick={onFileClick} />
                      </div>
                    )}
                  </>
                )}
              </Stack>
            )
          })}
        </Stack>
      )}
    </div>
  )
}
