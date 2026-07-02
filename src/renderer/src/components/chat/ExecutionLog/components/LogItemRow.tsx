import React from 'react'
import Flex from '../../../ui/Flex'
import {
  type UnifiedTimelineItem,
  getFileIconComponent
} from '../utils'
import { buildDiffEditInfo } from '../../../../utils/editDiffUtils'
import ExecutionLogDetail from '../../ExecutionLogDetail'
import { ThoughtIcon, SearchIcon, CmdIcon } from '../../../svg-icons'
import { FileIcon, FolderIcon } from '@react-symbols/icons/utils'

const VERB_TRANSLATIONS: Record<string, string> = {
  Thought: '思考',
  Analyzing: '正在读取',
  Analyzed: '已读取',
  Explored: '已浏览',
  Exploring: '正在浏览',
  Searched: '已搜索',
  Searching: '正在搜索',
  Terminal: '运行命令',
  Edited: '已修改',
  Editing: '正在修改',
  Created: '已创建',
  Creating: '正在创建',
  Executed: '已执行',
  Executing: '正在执行'
}

interface LogItemRowProps {
  item: UnifiedTimelineItem
  isLast: boolean
  isItemExpanded: boolean
  hasItemDetail: boolean
  toggleItemExpand: (id: string, e: React.MouseEvent) => void
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
}

export function LogItemRow({
  item,
  isLast,
  isItemExpanded,
  hasItemDetail,
  toggleItemExpand,
  onFileClick,
  onDiffClick
}: LogItemRowProps): React.ReactElement {
  const getItemIcon = (item: UnifiedTimelineItem) => {
    if (item.type === 'reasoning') return <ThoughtIcon running={item.status === 'running'} />
    if (item.type === 'command') return <CmdIcon />
    if (item.type === 'edit') return getFileIconComponent(item.fileName)
    if (item.type === 'tool') {
      if (item.verb === 'Searched' || item.verb === 'Searching') return <SearchIcon />
      if (item.verb === 'Explored' || item.verb === 'Exploring') return <FolderIcon folderName="" />
      if (item.verb === 'Executed' || item.verb === 'Executing') return <CmdIcon />
      return getFileIconComponent(item.fileName)
    }
    return <FileIcon fileName="" />
  }

  const isSnapshotItem =
    item.type === 'tool' && (item.toolName === 'get_project_snapshot' || item.target === '项目快照')
  const isFileItem =
    item.type === 'edit' || (item.type === 'tool' && item.verb === 'Analyzed' && (item.fileName || isSnapshotItem))

  return (
    <div className="timeline-item-wrapper" style={{ display: 'flex', flexDirection: 'column' }}>
      {!isLast && <div className="timeline-line-indicator" />}

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
            className={`timeline-item-row ${hasItemDetail ? 'interactive' : ''}`}
            onClick={(e) => hasItemDetail && toggleItemExpand(item.id, e)}
          >
            <Flex align="center" gap={2} className="min-w-0 relative">
              <span className="timeline-icon-box">{getItemIcon(item)}</span>
              <span className="truncate pr-4">
                <span
                  className={`timeline-verb-text timeline-verb-${item.verb.toLowerCase()}`}
                  title={item.toolName ? `调用工具: ${item.toolName}` : undefined}
                >
                  {VERB_TRANSLATIONS[item.verb] || item.verb}
                </span>
                {item.verb === 'Searched' || item.verb === 'Searching' ? (
                  <span className="timeline-target-link" style={{ textDecoration: 'none', cursor: 'default' }}>
                    查找 {item.target}
                  </span>
                ) : isFileItem ? (
                  <span
                    className="timeline-target-link"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (item.type === 'edit') {
                        const diffInfo = buildDiffEditInfo(item.toolName || '', item.args || '')
                        if (diffInfo) {
                          onDiffClick?.(item.target, diffInfo)
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
                            markdownContent = parts.join('\n')
                          }
                        } catch {
                          markdownContent = item.detail || ''
                        }
                        onFileClick?.('project_snapshot.md', markdownContent)
                      } else {
                        onFileClick?.(item.target)
                      }
                    }}
                  >
                    {item.target}
                  </span>
                ) : (
                  <span className="timeline-target-text">{item.target}</span>
                )}
              </span>
            </Flex>
          </Flex>

          {hasItemDetail && isItemExpanded && (
            <div className="timeline-detail-box">
              <ExecutionLogDetail item={item} />
            </div>
          )}
        </>
      )}
    </div>
  )
}
