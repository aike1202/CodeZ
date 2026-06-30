/**
 * editDiffUtils.ts
 * 统一管理 diff 相关的计算和交互逻辑。
 * 从 ChatArea / ExecutionLogUtils / ExecutionLog 三处提取的公共函数。
 */
import { parseArgs } from './parseArgs'

export interface EditStats {
  additions: string
  deletions: string
}

export interface DiffEditInfo {
  type: 'write' | 'replace'
  targetContent?: string
  replacementContent?: string
  codeContent?: string
}

/**
 * 计算单个工具调用的行数变更统计。
 * 统一处理 write_to_file / replace_file_content / multi_replace_file_content / apply_patch 四种工具。
 */
export function computeEditStats(toolName: string, args: string): EditStats {
  const argsObj = parseArgs(args)
  let additions = '+0'
  let deletions = '-0'

  if (toolName === 'write_to_file') {
    const codeContent = argsObj.codeContent || argsObj.code_content || ''
    if (typeof codeContent === 'string') {
      additions = `+${codeContent.split('\n').length}`
    }
  } else if (toolName === 'replace_file_content') {
    if (typeof argsObj.replacementContent === 'string') {
      additions = `+${argsObj.replacementContent.split('\n').length}`
    }
    if (typeof argsObj.targetContent === 'string') {
      deletions = `-${argsObj.targetContent.split('\n').length}`
    }
  } else if (toolName === 'apply_patch') {
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
  } else if (toolName === 'Edit') {
    if (typeof argsObj.new_string === 'string') additions = `+${argsObj.new_string.split('\n').length}`
    if (typeof argsObj.old_string === 'string') deletions = `-${argsObj.old_string.split('\n').length}`
  } else if (toolName === 'Write') {
    if (typeof argsObj.content === 'string') additions = `+${argsObj.content.split('\n').length}`
  } else if (toolName === 'NotebookEdit') {
    if (typeof argsObj.new_source === 'string') additions = `+${argsObj.new_source.split('\n').length}`
  } else if (toolName === 'multi_replace_file_content') {
    const chunks = Array.isArray(argsObj.ReplacementChunks)
      ? argsObj.ReplacementChunks
      : Array.isArray(argsObj.replacementChunks)
        ? argsObj.replacementChunks
        : []
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

  return { additions, deletions }
}

/**
 * 根据工具调用构建 diff 预览所需的 editInfo 对象。
 * 返回值可直接传给 handleDiffClick。
 */
export function buildDiffEditInfo(toolName: string, args: string): DiffEditInfo {
  const argsObj = parseArgs(args)

  if (toolName === 'write_to_file') {
    return {
      type: 'write',
      codeContent: argsObj.codeContent || argsObj.code_content || ''
    }
  }

  if (toolName === 'multi_replace_file_content') {
    const chunks = Array.isArray(argsObj.ReplacementChunks)
      ? argsObj.ReplacementChunks
      : Array.isArray(argsObj.replacementChunks)
        ? argsObj.replacementChunks
        : []
    const targetContent = chunks
      .map((c: any, i: number) => `--- Chunk ${i + 1} ---\n${c.TargetContent || c.targetContent || ''}`)
      .join('\n\n')
    const replacementContent = chunks
      .map((c: any, i: number) => `--- Chunk ${i + 1} ---\n${c.ReplacementContent || c.replacementContent || ''}`)
      .join('\n\n')
    return { type: 'replace', targetContent, replacementContent }
  }

  if (toolName === 'apply_patch') {
    if (Array.isArray(argsObj.edits) && argsObj.edits.length > 0) {
      const targetContent = argsObj.edits
        .map((edit: any, i: number) => `--- Edit ${i + 1} ---\n${edit.targetContent || ''}`)
        .join('\n\n')
      const replacementContent = argsObj.edits
        .map((edit: any, i: number) => `--- Edit ${i + 1} ---\n${edit.replacementContent || ''}`)
        .join('\n\n')
      return { type: 'replace', targetContent, replacementContent }
    }
    return {
      type: 'write',
      codeContent: argsObj.newContent || ''
    }
  }

  if (toolName === 'Edit') {
    return { type: 'replace', targetContent: argsObj.old_string || '', replacementContent: argsObj.new_string || '' }
  }
  if (toolName === 'Write') {
    return { type: 'write', codeContent: argsObj.content || '' }
  }
  if (toolName === 'NotebookEdit') {
    return { type: 'replace', targetContent: '<notebook cell>', replacementContent: argsObj.new_source || '' }
  }

  // replace_file_content (default)
  return {
    type: 'replace',
    targetContent: argsObj.targetContent || '',
    replacementContent: argsObj.replacementContent || ''
  }
}

/**
 * 规范化文件路径用于比较：统一为小写正斜杠。
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/**
 * 从工具调用中提取目标文件路径。
 */
function getFilePathFromToolArgs(args: string): string {
  const argsObj = parseArgs(args)
  return argsObj.file_path || argsObj.notebook_path || argsObj.targetFile || argsObj.TargetFile || argsObj.filePath || argsObj.path || ''
}

/**
 * 从工具调用列表中找到匹配文件路径的工具，构建 editInfo 并触发 diff 预览。
 * 如果找不到匹配的工具调用，fallback 到文件预览。
 */
export function handleDiffClickForFile(
  filePath: string,
  tools: Array<{ name: string; args: string }>,
  handleDiffClick: (filePath: string, editInfo: DiffEditInfo) => void,
  handleFileClick: (filePath: string) => void
): void {
  const targetNorm = normalizePath(filePath)

  const tc = tools.find((t) => {
    if (!['Edit', 'Write', 'NotebookEdit'].includes(t.name)) {
      return false
    }
    const fileArg = getFilePathFromToolArgs(t.args)
    if (typeof fileArg === 'string') {
      const fileNorm = normalizePath(fileArg)
      return fileNorm === targetNorm || targetNorm.endsWith(fileNorm) || fileNorm.endsWith(targetNorm)
    }
    return false
  })

  if (tc) {
    try {
      const editInfo = buildDiffEditInfo(tc.name, tc.args)
      handleDiffClick(filePath, editInfo)
    } catch (err) {
      console.error('Failed to build diff info:', err)
      handleFileClick(filePath)
    }
  } else {
    handleFileClick(filePath)
  }
}
