import React from 'react'
import Flex from '../../../ui/Flex'
import {
  type UnifiedTimelineItem,
  getFileIconComponent
} from '../utils'
import { buildDiffEditInfo } from '../../../../utils/editDiffUtils'
import ExecutionLogDetail from '../../ExecutionLogDetail'
import { ThoughtIcon, SearchIcon, CmdIcon, AskIcon } from '../../../svg-icons'
import { FileIcon, FolderIcon } from '@react-symbols/icons/utils'
import './LogItemRow.css'

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
  Executing: '正在执行',
  Asked: '已提问',
  Asking: '正在提问',
  Submitting: '正在提交',
  Submitted: '已提交结果',
  Dispatching: '正在委派',
  Dispatched: '已委派子任务',
  Saving: '正在保存',
  Saved: '已保存文件',
  Updating: '正在更新',
  Updated: '已更新计划',
  Fetching: '正在获取',
  Fetched: '已获取网页',
  Invoking: '正在调用技能',
  Invoked: '已调用技能'
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
      if (item.verb === 'Asked' || item.verb === 'Asking') return <AskIcon />
      if (item.verb === 'Executed' || item.verb === 'Executing') return <CmdIcon />
      return getFileIconComponent(item.fileName)
    }
    return <FileIcon fileName="" />
  }

  const isFileItem =
    item.type === 'edit' || (item.type === 'tool' && item.verb === 'Analyzed' && item.fileName)

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
                      const filePath = item.realPath || item.target
                      if (item.type === 'edit') {
                        const diffInfo = buildDiffEditInfo(item.toolName || '', item.args || '')
                        if (diffInfo) {
                          onDiffClick?.(filePath, diffInfo)
                        }
                      } else {
                        onFileClick?.(filePath)
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
