import type { AgentState, ToolCallState, ReasoningTimelineItem } from '../../../../stores/chatStore'
import { parseArgs } from '../../../../utils/parseArgs'
import type { CommandItem, EditItemWithStatus } from './types'

export function getToolTarget(log: ToolCallState): string {
  const args = parseArgs(log.args)

  const targetPathsObj = args.targetPaths || args.TargetPaths || args.dirPaths || args.DirPaths
  if (Array.isArray(targetPathsObj) && targetPathsObj.length > 0) {
    const paths = targetPathsObj as string[]
    if (paths.length === 1) return paths[0]
    const names = paths.map((p) => p.split(/[/\\]/).pop()).slice(0, 3)
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
    args.file_path ||
    args.command ||
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
    case 'read_files':
      return '文件'
    case 'list_files':
    case 'list_dir':
      return '目录'
    case 'search_text':
      return '文本搜索'
    case 'search_code':
      return '代码搜索'
    case 'get_symbol_map':
      return '符号索引'
    case 'submit_result':
    case 'submit':
      return '提交结果'
    case 'SubAgentRunner':
    case 'spawn':
    case 'delegate':
      return '子任务'
    case 'DelegateTasks':
      return '多任务委派'
    case 'Write':
    case 'write_to_file':
      return '保存文件'
    case 'Skill':
    case 'invoke_skill':
      return '技能'
    case 'WebFetch':
    case 'web_fetch':
    case 'fetch':
      return '网页'
    case 'WebSearch':
    case 'web_search':
      return '网页搜索'
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
        status: state.status === 'error' ? 'error' : isRunning ? 'running' : 'success',
        isRunning
      }
    })
}
