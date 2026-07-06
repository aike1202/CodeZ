import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

/** 通过环境变量 CODEZ_LOG_PROMPT=1 启用 */
const ENABLED = process.env.CODEZ_LOG_PROMPT === '1'

let logPath = ''

function ensurePath(): string {
  if (logPath) return logPath
  const dir = app.getPath('logs')
  logPath = path.join(dir, `prompt-${Date.now()}.log`)
  return logPath
}

export function logPrompt(label: string, messageCount: number, systemContent?: string): void {
  if (!ENABLED) return
  try {
    const p = ensurePath()
    const ts = new Date().toISOString()
    const lines: string[] = []
    lines.push(`\n=== ${label} @ ${ts} ===`)
    lines.push(`Message count: ${messageCount}`)
    if (systemContent) {
      let body = systemContent
      if (body.length > 500_000) {
        body = body.slice(0, 500_000) + `\n... (truncated, total ${systemContent.length} chars)`
      }
      lines.push(`System prompt:\n${body}`)
    }
    lines.push('')
    fs.appendFileSync(p, lines.join('\n'), 'utf-8')
  } catch {
    // 静默失败
  }
}
