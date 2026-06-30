/* ============================================
   流式不完整 JSON 参数解析器
   ============================================ */
export function parseArgs(args: string): Record<string, any> {
  try {
    const parsed = JSON.parse(args)
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    // 忽略错误，进入松散提取
  }

  const result: Record<string, any> = {}
  const fields = [
    'targetFile',
    'TargetFile',
    'codeContent',
    'replacementContent',
    'targetContent',
    'path',
    'dirPath',
    'filePath',
    'directory',
    'query',
    'pattern',
    'regex',
    'startLine',
    'endLine',
    'DirectoryPath',
    'AbsolutePath',
    'SearchPath',
    'Url'
  ]

  fields.forEach((field) => {
    // 1. 匹配字符串: "field" \s* : \s* " ( [^"\\] * (?: \\. [^"\\] * )* ) "?
    const strPattern = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, 'ui')
    const strMatch = args.match(strPattern)
    if (strMatch) {
      let rawVal = strMatch[1]
      if (rawVal.endsWith('\\')) {
        rawVal = rawVal.slice(0, -1)
      }
      try {
        result[field] = JSON.parse(`"${rawVal}"`)
      } catch {
        result[field] = rawVal
          .replace(/\\n/gu, '\n')
          .replace(/\\t/gu, '\t')
          .replace(/\\"/gu, '"')
          .replace(/\\\\/gu, '\\')
      }
      return
    }

    // 2. 匹配数字
    const numPattern = new RegExp(`"${field}"\\s*:\\s*(\\d+)`, 'ui')
    const numMatch = args.match(numPattern)
    if (numMatch) {
      result[field] = parseInt(numMatch[1], 10)
    }
  })

  return result
}
