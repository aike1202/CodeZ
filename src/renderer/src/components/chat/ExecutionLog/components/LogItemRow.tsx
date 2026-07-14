import React from 'react'
import Flex from '../../../ui/Flex'
import {
  type UnifiedTimelineItem,
  getFileIconComponent
} from '../utils'
import { buildDiffEditInfo } from '../../../../utils/editDiffUtils'
import ExecutionLogDetail from '../../ExecutionLogDetail'
import { ThoughtIcon, SearchIcon, CmdIcon, AskIcon } from '../../../svg-icons'
import IconSkills from '../../../icons/IconSkills'
import { CircleAlert, CircleCheck, Minimize2, RefreshCw } from 'lucide-react'
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
  Invoked: '已调用技能',
  Deactivating: '正在停用技能',
  Deactivated: '已停用技能'
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
  const isSkillItem =
    item.type === 'tool' && (
      item.toolName === 'Skill' || item.toolName === 'ActivateSkill' ||
      item.toolName === 'DeactivateSkill' || item.toolName === 'invoke_skill'
    )
  const isTaskSummarySkill = isSkillItem && item.target === 'task-summary'

  const getItemIcon = (item: UnifiedTimelineItem) => {
    if (item.type === 'reasoning') return <ThoughtIcon running={item.status === 'running'} />
    if (item.type === 'compaction') {
      if (item.status === 'running') return <RefreshCw className="spin-slow" />
      if (item.status === 'error') return <CircleAlert />
      return <Minimize2 />
    }
    if (item.type === 'command') return <CmdIcon />
    if (item.type === 'edit') return getFileIconComponent(item.fileName)
    if (item.type === 'tool') {
      if (isTaskSummarySkill) return <CircleCheck />
      if (isSkillItem) return <IconSkills />
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
  const isEditItem = item.type === 'edit'
  const canOpenEditDiff = isEditItem && Boolean(item.args?.trim()) && Boolean(onDiffClick)

  const openFile = (event: React.MouseEvent) => {
    event.stopPropagation()
    onFileClick?.(item.realPath || item.target)
  }

  const openEditDiff = (event: React.MouseEvent) => {
    event.stopPropagation()
    const diffInfo = buildDiffEditInfo(item.toolName || '', item.args || '')
    onDiffClick?.(item.realPath || item.target, diffInfo)
  }

  return (
    <div className="timeline-item-wrapper" style={{ display: 'flex', flexDirection: 'column', minWidth: 0, width: '100%' }}>
      {!isLast && <div className="timeline-line-indicator" />}

      {item.type === 'text' ? (
        <Flex align="start" gap={2} className="timeline-detail-status-line" style={{ minWidth: 0, width: '100%' }}>
          <span className="timeline-detail-working-badge animate-pulse">Working</span>
          <span className="whitespace-pre-wrap break-all" style={{ minWidth: 0 }}>{(item as any).content || item.detail}</span>
        </Flex>
      ) : (
        <>
          <Flex
            align="center"
            justify="between"
            className={`timeline-item-row ${hasItemDetail ? 'interactive' : ''}`}
            style={{ minWidth: 0, width: '100%' }}
            onClick={(e) => hasItemDetail && toggleItemExpand(item.id, e)}
          >
            <Flex align="center" gap={2} className="relative" style={{ flex: 1, minWidth: 0 }}>
              <span className={`timeline-icon-box${isTaskSummarySkill ? ' timeline-icon-completed' : isSkillItem ? ' timeline-icon-skill' : item.type === 'compaction' ? ` timeline-icon-compaction is-${item.status}` : ''}`}>
                {getItemIcon(item)}
              </span>
              <span className="timeline-target-truncate-box pr-4">
                {item.type === 'compaction' ? (
                  <span className="timeline-target-text" title={item.target}>{item.target}</span>
                ) : (
                  <span
                    className={`timeline-verb-text timeline-verb-${item.verb.toLowerCase()}${isTaskSummarySkill ? ' timeline-verb-task-completed' : ''}`}
                    title={isTaskSummarySkill ? '任务总结已生成' : item.toolName ? `调用工具: ${item.toolName}` : undefined}
                  >
                    {isTaskSummarySkill ? '任务已完成' : VERB_TRANSLATIONS[item.verb] || item.verb}
                  </span>
                )}
                {item.type === 'compaction' || isTaskSummarySkill ? null : item.verb === 'Searched' || item.verb === 'Searching' ? (
                  <span className="timeline-target-link" style={{ textDecoration: 'none', cursor: 'default' }}>
                    查找 {item.target}
                  </span>
                ) : isFileItem ? (
                  <span
                    className="timeline-target-link"
                    onClick={openFile}
                  >
                    {item.target}
                  </span>
                ) : (
                  <span className={`timeline-target-text${isSkillItem ? ' timeline-target-skill' : ''}`}>
                    {item.target}
                  </span>
                )}
              </span>
              {canOpenEditDiff ? (
                <button
                  type="button"
                  className="timeline-edit-diff-button"
                  aria-label={`查看 ${item.target} 的变更`}
                  title="查看变更 Diff"
                  onClick={openEditDiff}
                >
                  <span className="timeline-edit-diff-add">{item.additions || '+0'}</span>
                  <span className="timeline-edit-diff-del">{item.deletions || '-0'}</span>
                </button>
              ) : null}
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
