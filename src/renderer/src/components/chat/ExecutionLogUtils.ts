import React from 'react'
import type { AgentState, ExecutionTimelineItem, ReasoningTimelineItem, ToolCallState } from '../../stores/chatStore'
import { parseArgs } from '../../utils/parseArgs'
import { computeEditStats } from '../../utils/editDiffUtils'
import { FileIcon, FolderIcon } from '@react-symbols/icons/utils'
import {
  ThoughtIcon,
  SearchIcon,
  CmdIcon
} from '../svg-icons'

export type CommandItem = {
  id: string
  title: string
  status: 'running' | 'success' | 'error'
  timestamp: number
}

export type EditItem = {
  id: string
  filePath: string
  additions: string
  deletions: string
  timestamp: number
}

export interface UnifiedTimelineItem {
  id: string
  type: 'reasoning' | 'tool' | 'command' | 'edit' | 'text'
  timestamp: number
  status: 'running' | 'success' | 'error'
  verb: 'Thought' | 'Analyzed' | 'Analyzing' | 'Explored' | 'Exploring' | 'Searched' | 'Searching' | 'Terminal' | 'Edited' | 'Created' | 'Editing' | 'Creating' | 'Executed' | 'Executing'
  target: string
  detail?: string
  args?: string
  duration?: string
  additions?: string
  deletions?: string
  fileName?: string
  toolName?: string
  realPath?: string
}

export function getFileExtension(fileName?: string): string {
  if (!fileName) return ''
  const parts = fileName.split('.')
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''
}

export function getFileIconComponent(fileName?: string): React.ReactElement {
  if (!fileName) return React.createElement(FileIcon, { width: 14, height: 14 })
  const isDir = !fileName.includes('.')
  if (isDir) return React.createElement(FolderIcon, { folderName: fileName, width: 14, height: 14 })
  return React.createElement(FileIcon, { fileName, width: 14, height: 14 })
}

export function getToolTarget(log: ToolCallState): string {
  const args = parseArgs(log.args)

  const targetPathsObj = args.targetPaths || args.TargetPaths || args.dirPaths || args.DirPaths
  if (Array.isArray(targetPathsObj) && targetPathsObj.length > 0) {
    const paths = targetPathsObj as string[]
    if (paths.length === 1) return paths[0]
    const names = paths.map(p => p.split(/[/\\]/).pop()).slice(0, 3)
    return `${paths.length} 个目标 (${names.join(', ')}${paths.length > 3 ? '...' : ''})`
  }

  if (log.name === 'grep_search' || log.name === 'search_code' || log.name === 'search_text') {
    const query = args.Query || args.query || args.pattern || args.regex || ''
    const pathValue = args.SearchPath || args.DirectoryPath || args.path || args.dirPath || ''
    if (pathValue) {
      const pathName = pathValue.split(/[/\\]/).pop() || pathValue
      return `"${query}" (在 ${pathName})`
    }
    return `"${query}"`
  }

  const value =
    args.DirectoryPath ||
    args.directoryPath ||
    args.AbsolutePath ||
    args.absolutePath ||
    args.SearchPath ||
    args.searchPath ||
    args.targetFile ||
    args.TargetFile ||
    args.path ||
    args.dirPath ||
    args.filePath ||
    args.directory ||
    args.Directory ||
    args.query ||
    args.Query ||
    args.pattern ||
    args.Pattern ||
    args.regex ||
    args.Regex

  return typeof value === 'string' ? value : ''
}

export function getToolNoun(toolName: string): string {
  switch (toolName) {
    case 'read_file':
      return '文件'
    case 'list_files':
    case 'list_dir':
      return '目录'
    case 'search_text':
      return '文本搜索'
    case 'get_project_snapshot':
      return '项目快照'
    case 'read_files':
      return '文件'
    case 'search_code':
      return '代码搜索'
    case 'get_symbol_map':
      return '符号索引'
    case 'fast_context':
      return '快速上下文'
    default:
      return toolName
  }
}

export function formatDuration(log: ToolCallState): string {
  if (!log.completedAt) return ''
  return `${Math.max(log.completedAt - log.startedAt, 1)}ms`
}

export function formatReasoningDuration(item: ReasoningTimelineItem): string {
  const end = item.completedAt || item.updatedAt
  const duration = Math.max(end - item.startedAt, 1)
  if (duration < 1000) return `${duration}ms`
  return `${Math.round(duration / 1000)}s`
}

export function normalizeCommandTitle(title: string): string {
  return title
    .replace(/^正在运行\s*/u, '')
    .replace(/^已运行\s*/u, '')
    .replace(/^正在执行\s*/u, '')
    .replace(/^已执行\s*/u, '')
    .trim()
}

export function buildCommandItems(states: AgentState[]): CommandItem[] {
  return states
    .filter((state) => state.type === 'command_running' || state.type === 'command_completed')
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((state) => ({
      id: state.id,
      title: normalizeCommandTitle(state.title),
      status: state.type === 'command_running' ? 'running' : state.status === 'error' ? 'error' : 'success',
      timestamp: state.timestamp
    }))
}

export function parseEditDetail(detail: string | undefined): { additions: string; deletions: string } {
  if (!detail) return { additions: '+0', deletions: '-0' }

  return {
    additions: detail.match(/\+\d+/u)?.[0] || '+0',
    deletions: detail.match(/-\d+/u)?.[0] || '-0'
  }
}

export type EditItemWithStatus = EditItem & { status: 'running' | 'success' | 'error', isRunning: boolean }

export function buildEditItems(states: AgentState[]): EditItemWithStatus[] {
  return states
    .filter((state) => state.type === 'edit')
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((state) => {
      const detail = parseEditDetail(state.detail)
      const isRunning = state.status === 'pending' || state.title.startsWith('正在编辑')
      return {
        id: state.id,
        filePath: state.title.replace(/^正在编辑\s*/u, '').replace(/^已编辑\s*/u, '').trim(),
        additions: detail.additions,
        deletions: detail.deletions,
        timestamp: state.timestamp,
        status: state.status === 'error' ? 'error' : (isRunning ? 'running' : 'success'),
        isRunning
      }
    })
}

export function buildFallbackTimeline(timeline: ExecutionTimelineItem[] | undefined, reasoning?: string): ExecutionTimelineItem[] {
  if (timeline && timeline.length > 0) return timeline
  if (!reasoning?.trim()) return []

  const now = Date.now()
  const fallbackItem: ReasoningTimelineItem = {
    id: 'fallback_reasoning',
    type: 'reasoning',
    content: reasoning,
    status: 'success',
    startedAt: now,
    updatedAt: now,
    sequence: 0
  }

  return [fallbackItem]
}

export function buildUnifiedTimeline(
  timeline: ExecutionTimelineItem[],
  commands: CommandItem[],
  edits: EditItemWithStatus[],
  reasoning?: string,
  isStreaming?: boolean
): UnifiedTimelineItem[] {
  const list: UnifiedTimelineItem[] = []

  // 1. 处理 timeline (思考与工具调用)
  timeline.forEach((item) => {
    if (item.type === 'reasoning') {
      const durationStr = formatReasoningDuration(item)
      const isActuallyRunning = item.status === 'running' && isStreaming !== false
      list.push({
        id: item.id,
        type: 'reasoning',
        timestamp: item.startedAt,
        status: isActuallyRunning ? 'running' : 'success',
        verb: 'Thought',
        target: isActuallyRunning ? '思考中...' : `用时 ${durationStr}`,
        detail: item.content
      })
    } else if (item.type === 'text') {
      const isActuallyRunning = item.status === 'running' && isStreaming !== false
      list.push({
        id: item.id,
        type: 'text',
        timestamp: item.startedAt,
        status: isActuallyRunning ? 'running' : 'success',
        verb: 'Thought',
        target: '',
        detail: item.content
      })
    } else if (item.type === 'tool') {
      const tc = item.toolCall
      const duration = formatDuration(tc)

      if (tc.name === 'read_files') {
        const argsObj = parseArgs(tc.args)
        const filePaths = Array.isArray(argsObj.filePaths) ? argsObj.filePaths : []

        const startLine = argsObj.startLine ?? argsObj.StartLine
        const endLine = argsObj.endLine ?? argsObj.EndLine

        let targetText = '多个文件'
        if (filePaths.length === 1) {
          targetText = filePaths[0]
          if (typeof startLine === 'number' && typeof endLine === 'number') {
            targetText += ` #L${startLine}-${endLine}`
          } else if (typeof startLine === 'number') {
            targetText += ` #L${startLine}-`
          }
        } else if (filePaths.length > 1) {
          const names = filePaths.map(p => p.split(/[/\\]/).pop()).slice(0, 2)
          targetText = `${filePaths.length} 个文件 (${names.join(', ')}${filePaths.length > 2 ? '...' : ''})`
        }

        list.push({
          id: tc.id,
          type: 'tool',
          timestamp: tc.startedAt,
          status: tc.status,
          verb: 'Analyzed',
          target: targetText,
          realPath: filePaths.length === 1 ? filePaths[0] : undefined,
          fileName: filePaths.length === 1 ? filePaths[0].split(/[/\\]/).pop() : undefined,
          args: tc.args,
          detail: tc.result,
          duration: duration,
          toolName: tc.name
        })
      } else {
        const target = getToolTarget(tc) || getToolNoun(tc.name)

        if (tc.name === 'write_to_file' || tc.name === 'replace_file_content' || tc.name === 'multi_replace_file_content' || tc.name === 'apply_patch') {
          const { additions, deletions } = computeEditStats(tc.name, tc.args)

          list.push({
            id: tc.id,
            type: 'edit',
            timestamp: tc.startedAt,
            status: tc.status,
            verb: tc.status === 'running'
              ? (tc.name === 'write_to_file' ? 'Creating' : 'Editing')
              : (tc.name === 'write_to_file' ? 'Created' : 'Edited'),
            target: target,
            realPath: target,
            additions: additions,
            deletions: deletions,
            fileName: target.split(/[/\\]/).pop(),
            detail: tc.result,
            args: tc.args,
            toolName: tc.name
          })
          return
        }

        if ((tc.name === 'fast_context' || tc.name === 'read_files') && tc.args) {
          const argsObj = parseArgs(tc.args)
          const targetPaths = argsObj.targetPaths || argsObj.TargetPaths
          if (Array.isArray(targetPaths) && targetPaths.length > 0) {
            targetPaths.forEach((pathItem: string, index: number) => {
              const fileName = pathItem.split(/[/\\]/).pop() || pathItem
              const isRunning = tc.status === 'running'
              list.push({
                id: `${tc.id}_${index}`,
                type: 'tool',
                timestamp: tc.startedAt + index,
                status: tc.status,
                verb: isRunning ? 'Analyzing' : 'Analyzed',
                target: fileName,
                realPath: pathItem,
                args: tc.args,
                detail: index === 0 ? tc.result : undefined,
                duration: formatDuration(tc),
                fileName: fileName,
                toolName: tc.name
              })
            })
            return
          }
        }

        let verbDisplay: UnifiedTimelineItem['verb'] = 'Executed'
        if (tc.name === 'search_text' || tc.name === 'search_code' || tc.name === 'search') {
          verbDisplay = tc.status === 'running' ? 'Searching' : 'Searched'
        } else if (tc.name === 'list_files' || tc.name === 'list_dir') {
          verbDisplay = tc.status === 'running' ? 'Exploring' : 'Explored'
        } else if (tc.name === 'run_command') {
          verbDisplay = 'Terminal'
        } else if (tc.name === 'read_file' || tc.name === 'read_files' || tc.name === 'get_project_snapshot' || tc.name === 'fast_context' || tc.name === 'read_url_content' || tc.name === 'view_file') {
          verbDisplay = tc.status === 'running' ? 'Analyzing' : 'Analyzed'
        } else {
          verbDisplay = tc.status === 'running' ? 'Executing' : 'Executed'
        }

        let targetDisplay = target
        let startLine: number | undefined
        let endLine: number | undefined
        if (tc.name === 'read_file' || tc.name === 'view_file') {
          const argsObj = parseArgs(tc.args)
          const sLine = argsObj.startLine ?? argsObj.StartLine
          const eLine = argsObj.endLine ?? argsObj.EndLine
          if (typeof sLine === 'number' && typeof eLine === 'number') {
            startLine = sLine
            endLine = eLine
            targetDisplay = `${target} #L${startLine}-${endLine}`
          }
        }

        if (tc.name === 'run_command') {
          try {
            const cmdArgs = JSON.parse(tc.args)
            targetDisplay = cmdArgs.commandLine || cmdArgs.command || target
          } catch {
            // keep original target
          }
        }

        const cleanRealPath = getToolTarget(tc)
        const isActuallyRunning = tc.status === 'running' && isStreaming !== false
        
        list.push({
          id: tc.id,
          type: tc.name === 'run_command' ? 'command' : 'tool',
          timestamp: tc.startedAt,
          status: isActuallyRunning ? 'running' : tc.status === 'running' ? 'error' : tc.status,
          verb: verbDisplay,
          target: targetDisplay,
          realPath: cleanRealPath,
          args: tc.args,
          detail: tc.result,
          duration: formatDuration(tc),
          fileName: target.split(/[/\\]/).pop(),
          toolName: tc.name
        })
      }
    }
  })

  // 2. 处理 commands
  commands.forEach((cmd) => {
    const isActuallyRunning = cmd.status === 'running' && isStreaming !== false
    list.push({
      id: cmd.id,
      type: 'command',
      timestamp: cmd.timestamp,
      status: isActuallyRunning ? 'running' : cmd.status === 'running' ? 'error' : cmd.status,
      verb: 'Terminal',
      target: cmd.title,
      detail: isActuallyRunning ? '正在运行命令...' : '命令执行完成。'
    })
  })

  // 3. 处理 edits
  edits.forEach((edit) => {
    const isActuallyRunning = edit.status === 'running' && isStreaming !== false
    list.push({
      id: edit.id,
      type: 'edit',
      timestamp: edit.timestamp,
      status: isActuallyRunning ? 'running' : edit.status === 'running' ? 'error' : edit.status,
      verb: edit.isRunning && isActuallyRunning ? 'Editing' : 'Edited',
      target: edit.filePath,
      additions: edit.additions,
      deletions: edit.deletions,
      fileName: edit.filePath.split(/[/\\]/).pop()
    })
  })

  const hasReasoningInTimeline = timeline.some((item) => item.type === 'reasoning')
  if (!hasReasoningInTimeline && reasoning?.trim()) {
    const fallbackTimestamp = timeline.length > 0 ? timeline[0].startedAt - 1000 : Date.now()
    const isStillRunning = Boolean(isStreaming) || timeline.some((item) => item.type === 'reasoning' ? item.status === 'running' : item.type === 'tool' ? item.toolCall.status === 'running' : item.type === 'text' ? item.status === 'running' : false) || commands.some((cmd) => cmd.status === 'running')
    const duration = Math.max(Date.now() - fallbackTimestamp, 1)
    const durationStr = duration < 1000 ? `${duration}ms` : `${Math.round(duration / 1000)}s`

    list.push({
      id: 'fallback_reasoning_prop',
      type: 'reasoning',
      timestamp: fallbackTimestamp,
      status: isStillRunning ? 'running' : 'success',
      verb: 'Thought',
      target: isStillRunning ? '思考中...' : `用时 ${durationStr}`,
      detail: reasoning
    })
  }

  list.sort((a, b) => a.timestamp - b.timestamp)

  let lastRunningReasoningIdx = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].type === 'reasoning' && list[i].status === 'running') {
      lastRunningReasoningIdx = i
      break
    }
  }

  list.forEach((item, idx) => {
    if (item.type === 'reasoning' && item.status === 'running' && idx !== lastRunningReasoningIdx) {
      item.status = 'success'
      const originalItem = timeline.find((t) => t.id === item.id) as ReasoningTimelineItem | undefined
      if (originalItem) {
        const durationStr = formatReasoningDuration(originalItem)
        item.target = `用时 ${durationStr}`
      } else {
        const duration = Math.max(Date.now() - item.timestamp, 1)
        const durationStr = duration < 1000 ? `${duration}ms` : `${Math.round(duration / 1000)}s`
        item.target = `用时 ${durationStr}`
      }
    }
  })

  return list
}

export function buildSummaryText(items: UnifiedTimelineItem[], running: boolean): string {
  const readCount = items.filter((i) => i.type === 'tool' && i.verb === 'Analyzed').length
  const dirCount = items.filter((i) => i.type === 'tool' && i.verb === 'Explored').length
  const searchCount = items.filter((i) => i.verb === 'Searched').length
  const cmdCount = items.filter((i) => i.type === 'command').length
  const editCount = items.filter((i) => i.type === 'edit').length

  const parts = [
    readCount > 0 ? `${readCount} 个文件` : '',
    dirCount > 0 ? `${dirCount} 个目录` : '',
    searchCount > 0 ? `${searchCount} 次搜索` : '',
    cmdCount > 0 ? `${cmdCount} 条命令` : '',
    editCount > 0 ? `${editCount} 处修改` : ''
  ].filter(Boolean)

  const prefix = running ? '正在处理: ' : '已探索: '
  return parts.length > 0 ? `${prefix}${parts.join(', ')}` : running ? '运行中...' : '已完成'
}
