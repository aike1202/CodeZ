import type {
  NormalizedOperation,
  NormalizedOperationGraph,
  NormalizedRedirect
} from './operationTypes'

function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  let escaped = false
  for (const char of command.trim()) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '^') {
      escaped = true
      continue
    }
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (/\s/.test(char) && !quoted) {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}

function collapseLineContinuations(command: string): string {
  return command.replace(/(\^+)(\r\n|\r|\n)/g, (_match, carets: string, newline: string) => {
    return carets.length % 2 === 1 ? carets.slice(0, -1) : carets + newline
  })
}

export class CmdCommandParser {
  parse(command: string): NormalizedOperationGraph {
    const executableCommand = collapseLineContinuations(command)
    const segments: string[] = []
    const operators: string[] = []
    const redirects: NormalizedRedirect[] = []
    let current = ''
    let quoted = false
    let escaped = false

    for (let index = 0; index < executableCommand.length; index++) {
      const char = executableCommand[index]
      if (escaped) {
        current += char
        escaped = false
        continue
      }
      if (char === '^') {
        current += char
        escaped = true
        continue
      }
      if (char === '"') {
        quoted = !quoted
        current += char
        continue
      }
      if (!quoted) {
        if (char === '\r' || char === '\n') {
          if (current.trim()) segments.push(current.trim())
          current = ''
          operators.push('\n')
          if (char === '\r' && executableCommand[index + 1] === '\n') index++
          continue
        }
        const pair = executableCommand.slice(index, index + 2)
        if (pair === '&&' || pair === '||' || pair === '>>') {
          if (pair === '>>') {
            const target = executableCommand.slice(index + 2).trim().split(/\s/)[0] || ''
            redirects.push({ operator: '>>', target })
            current += pair
          } else {
            if (current.trim()) segments.push(current.trim())
            current = ''
            operators.push(pair)
          }
          index++
          continue
        }
        if (char === '&' || char === '|') {
          if (current.trim()) segments.push(current.trim())
          current = ''
          operators.push(char)
          continue
        }
        if (char === '>' || char === '<') {
          const target = executableCommand.slice(index + 1).trim().split(/\s/)[0] || ''
          redirects.push({ operator: char, target })
        }
      }
      current += char
    }
    if (current.trim()) segments.push(current.trim())

    const operations: NormalizedOperation[] = segments.map((source) => {
      const argv = tokenize(source)
      return {
        shell: 'cmd',
        source,
        executable: argv[0] || '',
        argv,
        dynamic: argv.length === 0 || /[%!]/.test(argv[0] || ''),
        children: []
      }
    })

    return { shell: 'cmd', source: command, operations, operators, redirects, diagnostics: [] }
  }
}
