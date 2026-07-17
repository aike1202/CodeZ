import { desktopApi } from '../shared/desktop'

type RendererLogLevel = 'debug' | 'info' | 'warn' | 'error'

const MAX_RENDERER_LOG_MESSAGE_BYTES = 4 * 1024
const encoder = new TextEncoder()

function boundedText(value: string): string {
  if (encoder.encode(value).length <= MAX_RENDERER_LOG_MESSAGE_BYTES) return value

  let start = 0
  let end = value.length
  while (start < end) {
    const middle = Math.ceil((start + end) / 2)
    if (encoder.encode(value.slice(0, middle)).length <= MAX_RENDERER_LOG_MESSAGE_BYTES) {
      start = middle
    } else {
      end = middle - 1
    }
  }
  return value.slice(0, start)
}

function rendererLogMessage(args: readonly unknown[]): string {
  const message = args.map((value) => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value)
    }
    if (typeof value === 'bigint') return `${value}n`
    if (value === null) return 'null'
    if (value === undefined) return 'undefined'
    return '[non-text value omitted]'
  }).join(' ')
  return boundedText(message)
}

class Logger {
  private write(level: RendererLogLevel, args: readonly unknown[]): void {
    void desktopApi.logger[level](rendererLogMessage(args)).catch(() => undefined)
    console[level](...args)
  }

  info(...args: unknown[]): void {
    this.write('info', args)
  }

  warn(...args: unknown[]): void {
    this.write('warn', args)
  }

  error(...args: unknown[]): void {
    this.write('error', args)
  }

  debug(...args: unknown[]): void {
    this.write('debug', args)
  }
}

export const logger = new Logger();
export default logger;
