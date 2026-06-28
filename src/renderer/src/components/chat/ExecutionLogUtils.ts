import React from 'react'
import type { AgentState, ExecutionTimelineItem, ReasoningTimelineItem, ToolCallState } from '../../stores/chatStore'
import { parseArgs } from '../../utils/parseArgs'
import {
  ReactIcon,
  TSIcon,
  JSIcon,
  CSSIcon,
  HTMLIcon,
  MDIcon,
  ConfigIcon,
  FileIcon,
  FolderIcon,
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
  verb: 'Thought' | 'Analyzed' | 'Analyzing' | 'Explored' | 'Exploring' | 'Searched' | 'Searching' | 'Terminal' | 'Edited' | 'Created' | 'Editing' | 'Creating'
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
  const ext = getFileExtension(fileName)
  switch (ext) {
    case 'tsx':
    case 'jsx':
      return React.createElement(ReactIcon)
    case 'ts':
      return React.createElement(TSIcon)
    case 'js':
      return React.createElement(JSIcon)
    case 'css':
    case 'scss':
    case 'less':
      return React.createElement(CSSIcon)
    case 'html':
      return React.createElement(HTMLIcon)
    case 'md':
      return React.createElement(MDIcon)
    case 'json':
    case 'yaml':
    case 'yml':
    case 'toml':
    case 'ini':
    case 'xml':
      return React.createElement(ConfigIcon)
    default:
      return React.createElement(FileIcon)
  }
}

export function getToolTarget(log: ToolCallState): string {
  const args = parseArgs(log.args)

  if (Array.isArray(args.targetPaths) && args.targetPaths.length > 0) {
    const paths = args.targetPaths as string[]
    if (paths.length === 1) return paths[0]
    const names = paths.map(p => p.split(/[/\\]/).pop()).slice(0, 3)
    return `${paths.length} targets (${names.join(', ')}${paths.length > 3 ? '...' : ''})`
  }

  const value =
    args.targetFile ||
    args.TargetFile ||
    args.path ||
    args.dirPath ||
    args.filePath ||
    args.directory ||
    args.query ||
    args.pattern ||
    args.regex

  return typeof value === 'string' ? value : ''
}

export function getToolNoun(toolName: string): string {
  switch (toolName) {
    case 'read_file':
      return '文件'
    case 'list_files':
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
        target: isActuallyRunning ? 'Thinking...' : `Thought for ${durationStr}`,
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

        let targetText = 'Files'
        if (filePaths.length === 1) {
          targetText = filePaths[0]
        } else if (filePaths.length > 1) {
          const names = filePaths.map(p => p.split(/[/\\]/).pop()).slice(0, 2)
          targetText = `${filePaths.length} files (${names.join(', ')}${filePaths.length > 2 ? '...' : ''})`
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
          const argsObj = parseArgs(tc.args)
          let additions = '+0'
          let deletions = '-0'

          if (tc.name === 'write_to_file') {
            const codeContent = argsObj.codeContent || argsObj.code_content
            if (typeof codeContent === 'string') {
              additions = `+${codeContent.split('\n').length}`
            }
          } else if (tc.name === 'replace_file_content') {
            if (typeof argsObj.replacementContent === 'string') {
              additions = `+${argsObj.replacementContent.split('\n').length}`
            }
            if (typeof argsObj.targetContent === 'string') {
              deletions = `-${argsObj.targetContent.split('\n').length}`
            }
          } else if (tc.name === 'apply_patch') {
            if (Array.isArray(argsObj.edits)) {
              let totalAdds = 0
              let totalDels = 0
              argsObj.edits.forEach((edit: any) => {
                totalAdds += String(edit.replacementContent || '').split('\n').length
                totalDels += String(edit.targetContent || '').split('\n').length
              })
              additions = `+${totalAdds}`
              deletions = `-${totalDels}`
            } else if (typeof argsObj.newContent === 'string') {
              additions = `+${argsObj.newContent.split('\n').length}`
            }
          } else if (tc.name === 'multi_replace_file_content') {
            const chunks = Array.isArray(argsObj.ReplacementChunks) ? argsObj.ReplacementChunks : (Array.isArray(argsObj.replacementChunks) ? argsObj.replacementChunks : [])
            let totalAdds = 0
            let totalDels = 0
            chunks.forEach((chunk: any) => {
              const add = chunk.ReplacementContent || chunk.replacementContent || ''
              const del = chunk.TargetContent || chunk.targetContent || ''
              totalAdds += add.split('\n').length
              totalDels += del.split('\n').length
            })
            additions = `+${totalAdds}`
            deletions = `-${totalDels}`
          }

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

        const verb = tc.name === 'search_text' || tc.name === 'search_code' || tc.name === 'search' ? 'Searched' : 'Analyzed'

        let verbDisplay: 'Thought' | 'Analyzed' | 'Analyzing' | 'Explored' | 'Searched' | 'Terminal' | 'Edited' | 'Created' | 'Editing' | 'Creating' = verb
        if (tc.name === 'list_files') {
          verbDisplay = 'Explored'
        } else if (tc.name === 'run_command') {
          verbDisplay = 'Terminal'
        }

        let targetDisplay = target
        let startLine: number | undefined
        let endLine: number | undefined
        if (tc.name === 'read_file') {
          const argsObj = parseArgs(tc.args)
          if (typeof argsObj.startLine === 'number' && typeof argsObj.endLine === 'number') {
            startLine = argsObj.startLine
            endLine = argsObj.endLine
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
      detail: isActuallyRunning ? 'Running command...' : 'Command completed.'
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
      target: isStillRunning ? 'Thinking...' : `Thought for ${durationStr}`,
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
        item.target = `Thought for ${durationStr}`
      } else {
        const duration = Math.max(Date.now() - item.timestamp, 1)
        const durationStr = duration < 1000 ? `${duration}ms` : `${Math.round(duration / 1000)}s`
        item.target = `Thought for ${durationStr}`
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
    readCount > 0 ? `${readCount} file${readCount > 1 ? 's' : ''}` : '',
    dirCount > 0 ? `${dirCount} folder${dirCount > 1 ? 's' : ''}` : '',
    searchCount > 0 ? `${searchCount} search${searchCount > 1 ? 'es' : ''}` : '',
    cmdCount > 0 ? `${cmdCount} command${cmdCount > 1 ? 's' : ''}` : '',
    editCount > 0 ? `${editCount} edit${editCount > 1 ? 's' : ''}` : ''
  ].filter(Boolean)

  const prefix = running ? 'Working: ' : 'Explored: '
  return parts.length > 0 ? `${prefix}${parts.join(', ')}` : running ? 'Working...' : 'Completed'
}
