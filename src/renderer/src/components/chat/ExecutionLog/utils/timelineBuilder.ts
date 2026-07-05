import type { ExecutionTimelineItem, ReasoningTimelineItem } from '../../../../stores/chatStore'
import { parseArgs } from '../../../../utils/parseArgs'
import { computeEditStats } from '../../../../utils/editDiffUtils'
import type { CommandItem, EditItemWithStatus, UnifiedTimelineItem } from './types'
import { getToolTarget, getToolNoun, formatDuration, formatReasoningDuration } from './itemParsers'

export function buildFallbackTimeline(
  timeline: ExecutionTimelineItem[] | undefined,
  reasoning?: string
): ExecutionTimelineItem[] {
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

      if (tc.name === 'Read') {
        const argsObj = parseArgs(tc.args)
        const fp = argsObj.file_path || ''
        const offset = argsObj.offset
        const limit = argsObj.limit
        let targetText = fp || '文件'
        if (typeof offset === 'number')
          targetText += ` #L${offset}${typeof limit === 'number' ? `-${offset + limit - 1}` : '-'}`
        list.push({
          id: tc.id,
          type: 'tool',
          timestamp: tc.startedAt,
          status: tc.status,
          verb: tc.status === 'running' ? 'Analyzing' : 'Analyzed',
          target: targetText,
          realPath: fp,
          fileName: fp ? fp.split(/[/\\]/).pop() : undefined,
          args: tc.args,
          detail: tc.result,
          duration,
          toolName: tc.name
        })
      } else if (tc.name === 'read_files') {
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
          const names = filePaths.map((p) => p.split(/[/\\]/).pop()).slice(0, 2)
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

        if (['Edit', 'Write', 'NotebookEdit'].includes(tc.name)) {
          const { additions, deletions } = computeEditStats(tc.name, tc.args)

          list.push({
            id: tc.id,
            type: 'edit',
            timestamp: tc.startedAt,
            status: tc.status,
            verb:
              tc.status === 'running'
                ? tc.name === 'Write'
                  ? 'Creating'
                  : 'Editing'
                : tc.name === 'Write'
                  ? 'Created'
                  : 'Edited',
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

        if (tc.name === 'read_files' && tc.args) {
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
        if (tc.name === 'Grep' || tc.name === 'search') {
          verbDisplay = tc.status === 'running' ? 'Searching' : 'Searched'
        } else if (tc.name === 'Glob' || tc.name === 'list_files' || tc.name === 'list_dir') {
          verbDisplay = tc.status === 'running' ? 'Exploring' : 'Explored'
        } else if (tc.name === 'Bash' || tc.name === 'PowerShell' || tc.name === 'run_command') {
          verbDisplay = 'Terminal'
        } else if (
          tc.name === 'Read' ||
          tc.name === 'read_files'
        ) {
          verbDisplay = tc.status === 'running' ? 'Analyzing' : 'Analyzed'
        } else if (tc.name === 'AskUserQuestion') {
          verbDisplay = tc.status === 'running' ? 'Asking' : 'Asked'
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

        if (tc.name === 'Bash' || tc.name === 'PowerShell' || tc.name === 'run_command') {
          try {
            const cmdArgs = JSON.parse(tc.args)
            targetDisplay = cmdArgs.command || cmdArgs.commandLine || target
          } catch {
            // keep original target
          }
        }

        // AskUserQuestion：折叠态展示首个问题的 header 作为标题
        if (tc.name === 'AskUserQuestion') {
          try {
            const askArgs = JSON.parse(tc.args)
            const firstQ = Array.isArray(askArgs.questions) ? askArgs.questions[0] : null
            if (firstQ) {
              const qCount = askArgs.questions.length
              targetDisplay = firstQ.header || firstQ.question || '用户问题'
              if (qCount > 1) targetDisplay += ` 等 ${qCount} 个问题`
            }
          } catch {
            // keep original target
          }
        }

        const cleanRealPath = getToolTarget(tc)
        const isActuallyRunning = tc.status === 'running' && isStreaming !== false

        list.push({
          id: tc.id,
          type: tc.name === 'Bash' || tc.name === 'PowerShell' || tc.name === 'run_command' ? 'command' : 'tool',
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
    const isStillRunning =
      Boolean(isStreaming) ||
      timeline.some((item) =>
        item.type === 'reasoning'
          ? item.status === 'running'
          : item.type === 'tool'
            ? item.toolCall.status === 'running'
            : item.type === 'text'
              ? item.status === 'running'
              : false
      ) ||
      commands.some((cmd) => cmd.status === 'running')
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
