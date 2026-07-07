import type { AskUserAnswer } from '../../tools/builtin/AskUserQuestionTool'

const RECOVERABLE_PATTERNS = [
  /网络错误/i,
  /network/i,
  /fetch failed/i,
  /timeout|超时/i,
  /等待首个响应超时/i,
  /响应流已超时/i,
  /鉴权失败|unauthorized|invalid api key|api key|401/i,
  /rate limit|too many requests|请求过于频繁|429/i,
  /quota|insufficient|余额|额度/i,
  /模型或端点不存在|model.*not.*found|404/i,
  /provider/i,
]

export function isRecoverableProviderError(error: string): boolean {
  const message = error || ''
  if (!message.trim()) return false
  return RECOVERABLE_PATTERNS.some(pattern => pattern.test(message))
}

export function shouldRetryAfterUserMaintenance(answers: AskUserAnswer[] | undefined): boolean {
  const first = answers?.[0]?.answer
  if (Array.isArray(first)) {
    return first.some(value => /继续|重试|retry|continue/i.test(value))
  }
  return typeof first === 'string' && /继续|重试|retry|continue/i.test(first)
}
