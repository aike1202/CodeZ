import type { UnifiedTimelineItem } from './types'

export interface AskSummary {
  /** 问题标题（header 或 question 文本） */
  question: string
  /** 用户回答文本，为空表示尚未回答 */
  answer: string
}

/**
 * 从时间线中提取提问摘要信息。
 * 返回第一个已完成提问的问题与回答，用于在折叠头部中展示。
 */
export function extractAskSummary(items: UnifiedTimelineItem[]): AskSummary | null {
  const askItems = items.filter(
    (i) => (i.verb === 'Asked' || i.verb === 'Asking') && i.toolName === 'AskUserQuestion'
  )
  if (askItems.length === 0) return null

  // 取最后一个有结果的提问项
  for (let i = askItems.length - 1; i >= 0; i--) {
    const item = askItems[i]
    let question = ''
    let answer = ''

    // 从 args 中提取问题文本
    try {
      const argsObj = JSON.parse(item.args || '{}')
      const firstQ = Array.isArray(argsObj.questions) ? argsObj.questions[0] : null
      if (firstQ) {
        question = firstQ.header || firstQ.question || ''
      }
    } catch {
      // ignore parse error
    }

    // 从 detail 中提取回答文本
    try {
      if (item.detail) {
        const answers = JSON.parse(item.detail)
        if (Array.isArray(answers) && answers.length > 0) {
          const firstAnswer = answers[0]
          if (firstAnswer.answer === '__IGNORED__' || 
              (Array.isArray(firstAnswer.answer) && firstAnswer.answer.includes('__IGNORED__'))) {
            answer = '已忽略'
          } else if (Array.isArray(firstAnswer.answer)) {
            answer = firstAnswer.answer.join('、')
          } else if (firstAnswer.answer) {
            answer = firstAnswer.answer
          }
        }
      }
    } catch {
      // ignore parse error
    }

    if (question) {
      return { question, answer }
    }
  }

  return null
}

export function buildSummaryText(
  items: UnifiedTimelineItem[],
  running: boolean,
  interrupted = false
): string {
  if (interrupted) return '执行已中断'
  const readCount = items.filter((i) => i.type === 'tool' && i.verb === 'Analyzed').length
  const dirCount = items.filter((i) => i.type === 'tool' && i.verb === 'Explored').length
  const searchCount = items.filter((i) => i.verb === 'Searched').length
  const cmdCount = items.filter((i) => i.type === 'command').length
  const editCount = items.filter((i) => i.type === 'edit').length
  const askCount = items.filter((i) => i.verb === 'Asked' || i.verb === 'Asking').length

  const parts = [
    readCount > 0 ? `${readCount} 个文件` : '',
    dirCount > 0 ? `${dirCount} 个目录` : '',
    searchCount > 0 ? `${searchCount} 次搜索` : '',
    cmdCount > 0 ? `${cmdCount} 条命令` : '',
    editCount > 0 ? `${editCount} 处修改` : '',
    askCount > 0 ? `${askCount} 次提问` : ''
  ].filter(Boolean)

  // 如果有提问项，使用更贴切的前缀
  const hasAskOnly = askCount > 0 && parts.length === 1
  const prefix = running
    ? '正在处理: '
    : hasAskOnly
      ? '已提问: '
      : '已探索: '
  return parts.length > 0 ? `${prefix}${parts.join(', ')}` : running ? '运行中...' : '已完成'
}
