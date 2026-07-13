import type { ExecutionTimelineItem, ReasoningTimelineItem } from '../../../../stores/chatStore'
import { parseArgs } from '../../../../utils/parseArgs'
import { computeEditStats } from '../../../../utils/editDiffUtils'
import type { CommandItem, EditItemWithStatus, UnifiedTimelineItem } from './types'
import { getToolTarget, getToolNoun, formatDuration, formatReasoningDuration } from './itemParsers'
import { parseTaskUpdateDetail } from '../../ExecutionLogDetail/taskUpdateDetail'

function getReadFileStatuses(
  result: string | undefined,
  count: number,
  fallback: UnifiedTimelineItem['status']
): UnifiedTimelineItem['status'][] {
  if (!result || fallback === 'running') return Array(count).fill(fallback)

  const blocks = Array.from(result.matchAll(/<file path="[^"]*">\r?\n([\s\S]*?)\r?\n<\/file>/g))
  return Array.from({ length: count }, (_, index) => {
    const content = blocks[index]?.[1] || ''
    return content.startsWith('Error:') || content.startsWith('Cannot read binary file.')
      ? 'error'
      : fallback
  })
}

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
      if (tc.name === 'ToolSearch') return
      const duration = formatDuration(tc)
      const toolTimelineMeta = {
        completedAt: tc.completedAt,
        batchId: tc.batchId,
        batchIndex: tc.batchIndex,
        batchSize: tc.batchSize,
        batchKind: tc.batchId ? 'tools' as const : undefined
      }

      if (tc.name === 'Read') {
        const argsObj = parseArgs(tc.args)
        const files = Array.isArray(argsObj.files) ? argsObj.files : []
        const fileStatuses = getReadFileStatuses(tc.result, files.length, tc.status)

        if (files.length > 1) {
          if (tc.batchId) {
            const failed = fileStatuses.some((status) => status === 'error')
            list.push({
              id: tc.id,
              type: 'tool',
              timestamp: tc.startedAt,
              completedAt: tc.completedAt,
              status: failed ? 'error' : tc.status,
              verb: tc.status === 'running' ? 'Analyzing' : 'Analyzed',
              target: `${files.length} 个文件`,
              args: tc.args,
              detail: tc.result,
              duration,
              toolName: tc.name,
              batchId: tc.batchId,
              batchIndex: tc.batchIndex,
              batchSize: tc.batchSize,
              batchKind: 'tools'
            })
            return
          }

          const readBatchId = tc.batchId ?? `read_batch_${tc.id}`
          files.forEach((file: any, index: number) => {
            const filePath = typeof file?.file_path === 'string' ? file.file_path : ''
            const offset = file?.offset
            const limit = file?.limit
            let targetText = filePath || '文件'
            if (typeof offset === 'number') {
              targetText += ` #L${offset}${typeof limit === 'number' ? `-${offset + limit - 1}` : '-'}`
            }

            list.push({
              id: `${tc.id}_${index}`,
              type: 'tool',
              timestamp: tc.startedAt,
              completedAt: tc.completedAt,
              status: fileStatuses[index] ?? tc.status,
              verb: tc.status === 'running' ? 'Analyzing' : 'Analyzed',
              target: targetText,
              realPath: filePath,
              fileName: filePath ? filePath.split(/[/\\]/).pop() : undefined,
              args: tc.args,
              detail: index === 0 ? tc.result : undefined,
              duration,
              toolName: tc.name,
              batchId: readBatchId,
              batchIndex: tc.batchId ? tc.batchIndex : index,
              batchSize: tc.batchId ? tc.batchSize : files.length,
              batchKind: tc.batchId ? 'tools' : 'read'
            })
          })
          return
        }

        const file = files[0]
        const filePath = typeof file?.file_path === 'string' ? file.file_path : ''
        const offset = file?.offset
        const limit = file?.limit
        let targetText = filePath || '文件'
        if (typeof offset === 'number') {
          targetText += ` #L${offset}${typeof limit === 'number' ? `-${offset + limit - 1}` : '-'}`
        }
        list.push({
          id: tc.id,
          type: 'tool',
          timestamp: tc.startedAt,
          status: fileStatuses[0] ?? tc.status,
          verb: tc.status === 'running' ? 'Analyzing' : 'Analyzed',
          target: targetText,
          realPath: filePath,
          fileName: filePath ? filePath.split(/[/\\]/).pop() : undefined,
          args: tc.args,
          detail: tc.result,
          duration,
          toolName: tc.name,
          ...toolTimelineMeta
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
          toolName: tc.name,
          ...toolTimelineMeta
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
            toolName: tc.name,
            ...toolTimelineMeta
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
                toolName: tc.name,
                ...toolTimelineMeta
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
        } else if (tc.name === 'submit_result' || tc.name === 'submit') {
          verbDisplay = tc.status === 'running' ? 'Submitting' : 'Submitted'
        } else if (tc.name === 'SubAgentRunner' || tc.name === 'spawn' || tc.name === 'delegate') {
          verbDisplay = tc.status === 'running' ? 'Dispatching' : 'Dispatched'
        } else if (tc.name === 'DelegateTasks') {
          verbDisplay = tc.status === 'running' ? 'Executing' : 'Executed'
        } else if (tc.name === 'Write' || tc.name === 'write_to_file') {
          verbDisplay = tc.status === 'running' ? 'Saving' : 'Saved'
        } else if (tc.name === 'Skill' || tc.name === 'ActivateSkill' || tc.name === 'invoke_skill') {
          verbDisplay = tc.status === 'running' ? 'Invoking' : 'Invoked'
        } else if (tc.name === 'DeactivateSkill') {
          verbDisplay = tc.status === 'running' ? 'Deactivating' : 'Deactivated'
        } else if (tc.name === 'WebFetch' || tc.name === 'web_fetch' || tc.name === 'fetch') {
          verbDisplay = tc.status === 'running' ? 'Fetching' : 'Fetched'
        } else if (tc.name === 'WebSearch' || tc.name === 'web_search') {
          verbDisplay = tc.status === 'running' ? 'Searching' : 'Searched'
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

        // AskUserQuestion：将每个问题拆分为单独的日志项
        if (tc.name === 'AskUserQuestion') {
          try {
            const askArgs = JSON.parse(tc.args)
            if (Array.isArray(askArgs.questions) && askArgs.questions.length > 0) {
              const isActuallyRunning = tc.status === 'running' && isStreaming !== false
              
              askArgs.questions.forEach((q: any, index: number) => {
                const targetDisplay = q.header || q.question || '用户问题'
                const singleQuestionArgs = JSON.stringify({ ...askArgs, questions: [q] })
                
                list.push({
                  id: `${tc.id}_${index}`,
                  type: 'tool',
                  timestamp: tc.startedAt + index,
                  status: isActuallyRunning ? 'running' : tc.status === 'running' ? 'error' : tc.status,
                  verb: isActuallyRunning ? 'Asking' : 'Asked',
                  target: targetDisplay,
                  realPath: getToolTarget(tc),
                  args: singleQuestionArgs,
                  detail: tc.result,
                  duration: index === 0 ? formatDuration(tc) : undefined,
                  fileName: undefined,
                  toolName: tc.name,
                  ...toolTimelineMeta
                })
              })
              return
            }
          } catch {
            // keep original target
          }
        }

        // submit_result：展示提交摘要
        if (tc.name === 'submit_result') {
          try {
            const sa = JSON.parse(tc.args)
            if (sa.conclusion) {
              targetDisplay = sa.conclusion.slice(0, 80) + (sa.conclusion.length > 80 ? '…' : '')
            } else {
              targetDisplay = '提交研究结果'
            }
          } catch {
            targetDisplay = '提交结果'
          }
        }

        // SubAgentRunner / spawn / DelegateTasks：展示委派目标
        if (tc.name === 'SubAgentRunner' || tc.name === 'spawn' || tc.name === 'DelegateTasks') {
          try {
            const ta = JSON.parse(tc.args)
            targetDisplay = ta.description || ta.subagent_type || '子任务'
          } catch {
            targetDisplay = '委派子任务'
          }
        }

        // WebFetch：展示目标 URL
        if (tc.name === 'WebFetch' || tc.name === 'web_fetch') {
          try {
            const wa = JSON.parse(tc.args)
            const u = wa.url || wa.fetchInfo || ''
            if (u) targetDisplay = u.length > 60 ? u.slice(0, 60) + '…' : u
          } catch {}
        }

        // Skill：展示技能名
        if (tc.name === 'Skill' || tc.name === 'ActivateSkill' || tc.name === 'DeactivateSkill') {
          try {
            const ska = JSON.parse(tc.args)
            targetDisplay = ska.skill || ska.command || '技能'
          } catch {
            targetDisplay = '技能'
          }
        }

        // TaskCreate
        if (tc.name === 'TaskCreate') {
          try {
            const res = JSON.parse(tc.result || '{}')
            const created = res.data?.created || []
            if (created.length > 0) {
              const firstTask = created[0].subject
              targetDisplay = created.length > 1 ? `创建 ${created.length} 个任务 (如: ${firstTask})` : `创建任务: ${firstTask}`
            } else {
              targetDisplay = '创建任务'
            }
          } catch {
            targetDisplay = '创建任务'
          }
        }

        // TaskUpdate
        if (tc.name === 'TaskUpdate') {
          try {
            const res = JSON.parse(tc.result || '{}')
            const task = res.data?.task
            if (task) {
              if (task.status === 'completed') {
                targetDisplay = `完成任务：${task.subject}`
              } else if (task.status === 'in_progress') {
                targetDisplay = `开始执行: ${task.subject}`
              } else if (task.status === 'cancelled') {
                targetDisplay = `取消任务：${task.subject}`
              } else {
                targetDisplay = `更新任务: ${task.subject}`
              }
            } else {
              targetDisplay = '更新任务状态'
            }
          } catch {
            targetDisplay = '更新任务状态'
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
          toolName: tc.name,
          ...toolTimelineMeta
        })

        if (tc.name === 'DelegateTasks' && tc.status === 'success') {
          try {
            const result = JSON.parse(tc.result || '{}')
            const terminalTasks = Array.isArray(result?.data?.terminalTasks)
              ? result.data.terminalTasks
              : []

            terminalTasks.forEach((rawTask: unknown, index: number) => {
              const detail = JSON.stringify({
                ok: true,
                data: {
                  task: rawTask,
                  summary: result.data.status
                }
              })
              const task = parseTaskUpdateDetail(detail)?.task
              const isTerminal = task?.status === 'completed' || task?.status === 'cancelled'
              if (!isTerminal || !task.id || !task.subject) return

              list.push({
                id: `${tc.id}_task_${task.id}`,
                type: 'tool',
                timestamp: (tc.completedAt ?? tc.startedAt) + index + 1,
                completedAt: tc.completedAt,
                status: 'success',
                verb: 'Executed',
                target: task.status === 'completed'
                  ? `完成任务：${task.subject}`
                  : `取消任务：${task.subject}`,
                args: JSON.stringify({ taskId: task.id, status: task.status }),
                detail,
                toolName: 'TaskUpdate'
              })
            })
          } catch {
            // Keep the DelegateTasks row even when a legacy result cannot be expanded.
          }
        }
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
      realPath: edit.filePath,
      additions: edit.additions,
      deletions: edit.deletions,
      args: edit.args,
      fileName: edit.filePath.split(/[/\\]/).pop(),
      toolName: edit.toolName
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
