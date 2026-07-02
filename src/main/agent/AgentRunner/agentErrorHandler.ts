export function isToolErrorResult(resultMessage: string): boolean {
  const trimmed = resultMessage.trim()
  if (!trimmed) return false
  if (/^(Error:|Error in|Access denied|Hash mismatch)/i.test(trimmed)) return true

  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') {
      if (parsed.ok === false) return true
      if (parsed.error && !parsed.changedFiles && !parsed.data) return true
    }
  } catch {
    // Non-JSON successful tool output is still allowed.
  }

  return false
}

export function buildToolError(resultMessage: string) {
  const recoverable = /hash mismatch|not found|not unique|expectedhash|re-read|read_files|must read/i.test(
    resultMessage
  )
  return {
    code: recoverable ? 'RECOVERABLE_TOOL_ERROR' : 'TOOL_ERROR',
    message: resultMessage,
    recoverable,
    suggestion: recoverable
      ? 'Re-read the relevant file or range, then retry with updated arguments.'
      : undefined
  }
}
