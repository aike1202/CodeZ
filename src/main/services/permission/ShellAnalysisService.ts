import { Language, Parser, type Node } from 'web-tree-sitter'
import { resolveParserAsset } from './parserAssets'
import { CmdCommandParser } from './CmdCommandParser'
import type {
  NormalizedOperation,
  NormalizedOperationGraph,
  NormalizedRedirect,
  PermissionShellKind
} from './operationTypes'

let parserPromise: Promise<{ bash: Parser; powershell: Parser }> | null = null

async function loadParsers(): Promise<{ bash: Parser; powershell: Parser }> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init({ locateFile: () => resolveParserAsset('runtime') })
      const [bashLanguage, powershellLanguage] = await Promise.all([
        Language.load(resolveParserAsset('bash')),
        Language.load(resolveParserAsset('powershell'))
      ])
      const bash = new Parser()
      bash.setLanguage(bashLanguage)
      const powershell = new Parser()
      powershell.setLanguage(powershellLanguage)
      return { bash, powershell }
    })()
  }
  return parserPromise
}

function tokenizeWords(source: string, shell: PermissionShellKind): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: string | null = null
  let escaped = false
  for (const char of source.trim()) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if ((shell === 'bash' && char === '\\') || (shell === 'powershell' && char === '`')) {
      escaped = true
      continue
    }
    if ((char === '"' || char === "'") && !quote) {
      quote = char
      continue
    }
    if (char === quote) {
      quote = null
      continue
    }
    if (/\s/.test(char) && !quote) {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}

function findCommandNodes(node: Node, output: Node[] = []): Node[] {
  if (node.type === 'command') output.push(node)
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index)
    if (child) findCommandNodes(child, output)
  }
  return output
}

function scanSyntax(source: string): { operators: string[]; redirects: NormalizedRedirect[] } {
  const operators: string[] = []
  const redirects: NormalizedRedirect[] = []
  let quote: string | null = null
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if ((char === '"' || char === "'") && !quote) quote = char
    else if (char === quote) quote = null
    if (quote) continue
    const pair = source.slice(index, index + 2)
    if (pair === '&&' || pair === '||') {
      operators.push(pair)
      index++
      continue
    }
    if (pair === '>>') {
      redirects.push({ operator: '>>', target: source.slice(index + 2).trim().split(/\s/)[0] || '' })
      index++
      continue
    }
    if (char === '|' || char === ';') operators.push(char)
    if (char === '>' || char === '<') {
      redirects.push({ operator: char, target: source.slice(index + 1).trim().split(/\s/)[0] || '' })
    }
  }
  return { operators, redirects }
}

export class ShellAnalysisService {
  async parse(shell: PermissionShellKind, command: string): Promise<NormalizedOperationGraph> {
    if (shell === 'cmd') return new CmdCommandParser().parse(command)
    try {
      const parsers = await loadParsers()
      const tree = (shell === 'bash' ? parsers.bash : parsers.powershell).parse(command)
      if (!tree) throw new Error('Parser returned no syntax tree')
      const commandNodes = findCommandNodes(tree.rootNode)
      const operations: NormalizedOperation[] = commandNodes.map((node) => {
        const source = node.text.trim()
        const argv = tokenizeWords(source, shell)
        return {
          shell,
          source,
          executable: argv[0] || '',
          argv,
          dynamic: argv.length === 0 || /[$()`]/.test(argv[0] || ''),
          children: []
        }
      })
      const syntax = scanSyntax(command)
      return {
        shell,
        source: command,
        operations: operations.length > 0 ? operations : [{
          shell,
          source: command,
          executable: '',
          argv: [],
          dynamic: true,
          children: []
        }],
        ...syntax,
        diagnostics: tree.rootNode.hasError ? ['syntax-error'] : []
      }
    } catch (error) {
      return {
        shell,
        source: command,
        operations: [{ shell, source: command, executable: '', argv: [], dynamic: true, children: [] }],
        operators: [],
        redirects: [],
        diagnostics: [error instanceof Error ? error.message : String(error)]
      }
    }
  }
}
