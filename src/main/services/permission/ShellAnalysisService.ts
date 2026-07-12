import { Language, Parser, type Node } from 'web-tree-sitter'
import { spawn } from 'child_process'
import { resolveParserAsset } from './parserAssets'
import { CmdCommandParser } from './CmdCommandParser'
import { normalizeExecutableName } from './executableName'
import type {
  NormalizedOperation,
  NormalizedOperationGraph,
  NormalizedRedirect,
  PermissionShellKind
} from './operationTypes'

let parserPromise: Promise<{ bash: Parser; powershell: Parser }> | null = null
const nativePowerShellCache = new Map<string, Promise<NativePowerShellResult | null>>()

interface NativePowerShellResult {
  valid: boolean
  operations?: Array<{ source: string; dynamic: boolean }>
}

const NATIVE_POWERSHELL_PARSER = `
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$source = [Console]::In.ReadToEnd()
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if (@($errors).Count -gt 0) {
  [PSCustomObject]@{ valid = $false } | ConvertTo-Json -Compress
  exit 0
}
$operations = @($ast.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.CommandAst]
}, $true) | ForEach-Object {
  [PSCustomObject]@{
    source = $_.Extent.Text
    dynamic = ($null -eq $_.GetCommandName())
  }
})
[PSCustomObject]@{ valid = $true; operations = $operations } | ConvertTo-Json -Depth 4 -Compress
`

const POWERSHELL_NATIVE_OPTION_TERMINATOR_COMMANDS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'dotnet', 'mvn', 'mvnw', 'gradle', 'gradlew',
  'make', 'cmake', 'ninja', 'pytest', 'vitest', 'jest', 'node', 'deno', 'python', 'python3',
  'py', 'pip', 'pip3', 'uv', 'docker', 'kubectl', 'helm', 'npx', 'rg', 'ripgrep', 'rustc',
  'tsc', 'eslint', 'prettier', 'ant', 'sbt', 'msbuild', 'xbuild', 'bazel', 'bazelisk',
  'buck', 'buck2', 'meson', 'xcodebuild', 'swift', 'rustup', 'composer', 'bundle', 'bundler',
  'gem', 'nuget', 'terraform', 'tofu', 'ansible', 'ansible-playbook'
])

const POWERSHELL_ARGUMENT_LIST_COMMANDS = new Set([
  'get-childitem', 'gci', 'new-item', 'select-object', 'format-table'
])

const POWERSHELL_SCOPED_PACKAGE_COMMANDS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx'])

function supportsPowerShellArgumentLists(executable: string): boolean {
  return POWERSHELL_ARGUMENT_LIST_COMMANDS.has(executable) || /^[a-z]+-[a-z]+$/.test(executable)
}

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

function stripLeadingBashAssignments(argv: string[]): string[] {
  const commandIndex = argv.findIndex((argument) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument))
  return commandIndex < 0 ? [] : argv.slice(commandIndex)
}

function executableFromPrefix(prefix: string): string {
  const trimmed = prefix.trim()
  if (!trimmed) return ''
  const quote = trimmed[0]
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1)
    if (end > 0) return normalizeExecutableName(trimmed.slice(0, end + 1))
  }
  return normalizeExecutableName(trimmed.split(/\s+/, 1)[0] || '')
}

function maskPowerShellParserQuirks(source: string): string {
  const output = source.split('')
  let quote: string | null = null
  let escaped = false
  let statementStart = 0
  const parentStatements: number[] = []
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '`' && quote !== "'") {
      escaped = true
      continue
    }
    if ((char === '"' || char === "'") && quote === null) {
      quote = char
      continue
    }
    if (char === quote) {
      if (quote === "'" && source[index + 1] === "'") {
        index++
        continue
      }
      quote = null
      continue
    }
    if (quote) continue
    if (char === '(') {
      parentStatements.push(statementStart)
      statementStart = index + 1
      continue
    }
    if (char === ')') {
      statementStart = parentStatements.pop() ?? statementStart
      continue
    }
    if (/[\r\n;|&{}]/.test(char)) {
      statementStart = index + 1
      continue
    }
    const prefix = source.slice(statementStart, index).trim()
    const executable = executableFromPrefix(prefix)
    if (char === ',' && supportsPowerShellArgumentLists(executable)) {
      let previousIndex = index - 1
      let nextIndex = index + 1
      while (previousIndex >= statementStart && /\s/.test(source[previousIndex])) previousIndex--
      while (nextIndex < source.length && /\s/.test(source[nextIndex])) nextIndex++
      const previous = source[previousIndex] || ''
      const next = source[nextIndex] || ''
      if (previous && next && !/[;|&{}(),]/.test(previous) && !/[;|&{}(),]/.test(next)) {
        output[index] = ' '
        continue
      }
    }
    if (
      char === '@' &&
      POWERSHELL_SCOPED_PACKAGE_COMMANDS.has(executable) &&
      (!source[index - 1] || /\s/.test(source[index - 1])) &&
      /^[A-Za-z0-9_.-]+\//.test(source.slice(index + 1))
    ) {
      output[index] = 'z'
      continue
    }
    if (char !== '-') continue
    const before = index === 0 ? '' : source[index - 1]
    if (!POWERSHELL_NATIVE_OPTION_TERMINATOR_COMMANDS.has(executable)) continue
    if (before && !/\s/.test(before)) continue
    const next = source[index + 1] || ''
    if (next === '-') {
      const after = source[index + 2] || ''
      if (after && !/\s|[A-Za-z]/.test(after)) continue
      output[index] = 'z'
      output[index + 1] = 'z'
      index++
      continue
    }
    if (!next || /\s|[A-Za-z]/.test(next)) output[index] = 'z'
  }
  return output.join('')
}

function maskBashWindowsPaths(source: string): string {
  const output = source.split('')
  let quote: string | null = null
  let escaped = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if ((char === '"' || char === "'") && quote === null) {
      quote = char
      continue
    }
    if (char === quote) {
      quote = null
      continue
    }
    if (quote || char !== ':') continue
    const drive = source[index - 1] || ''
    const boundary = source[index - 2] || ''
    if (/[A-Za-z]/.test(drive) && source[index + 1] === '/' && (!boundary || /\s|=/.test(boundary))) {
      output[index] = '_'
    }
  }
  return output.join('')
}

function hasDynamicShellWrapperBody(argv: string[]): boolean {
  const executable = normalizeExecutableName(argv[0] || '')
  let body = ''
  if (['bash', 'sh', 'zsh'].includes(executable)) {
    const index = argv.findIndex((argument) => /^-[a-z]*c[a-z]*$/i.test(argument))
    if (index >= 0) body = argv[index + 1] || ''
  } else if (['powershell', 'pwsh'].includes(executable)) {
    const index = argv.findIndex((argument) => /^-(?:command|c)$/i.test(argument))
    if (index >= 0) body = argv.slice(index + 1).join(' ')
  } else if (executable === 'cmd') {
    const index = argv.findIndex((argument) => /^\/(?:c|k)$/i.test(argument))
    if (index >= 0) body = argv.slice(index + 1).join(' ')
  }
  return Boolean(body) && /\$(?:[A-Za-z_(]|\{)|`[^`]|%[^%]+%|![^!]+!/.test(body)
}

function runNativePowerShellParser(command: string): Promise<NativePowerShellResult | null> {
  const executable = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
  return new Promise((resolve) => {
    const encoded = Buffer.from(NATIVE_POWERSHELL_PARSER, 'utf16le').toString('base64')
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    })
    let stdout = ''
    let settled = false
    const finish = (result: NativePowerShellResult | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, 5000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 2 * 1024 * 1024) child.kill()
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      if (code !== 0) return finish(null)
      try {
        finish(JSON.parse(stdout.trim()) as NativePowerShellResult)
      } catch {
        finish(null)
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(command, 'utf8')
  })
}

async function parseWithNativePowerShell(command: string): Promise<NormalizedOperationGraph | null> {
  let pending = nativePowerShellCache.get(command)
  if (!pending) {
    pending = runNativePowerShellParser(command)
    nativePowerShellCache.set(command, pending)
    if (nativePowerShellCache.size > 128) {
      const oldest = nativePowerShellCache.keys().next().value
      if (oldest !== undefined) nativePowerShellCache.delete(oldest)
    }
  }
  const parsed = await pending
  if (!parsed?.valid) return null
  const operations: NormalizedOperation[] = (parsed.operations || []).map((operation) => {
    const rawArgv = tokenizeWords(operation.source, 'powershell')
    const argv = ['&', '.'].includes(rawArgv[0]) ? rawArgv.slice(1) : rawArgv
    return {
      shell: 'powershell',
      source: operation.source.trim(),
      executable: argv[0] || '',
      argv,
      dynamic: operation.dynamic || argv.length === 0 || /[$()`]/.test(argv[0] || '') || hasDynamicShellWrapperBody(argv),
      children: []
    }
  })
  const syntax = scanSyntax(command)
  return {
    shell: 'powershell',
    source: command,
    operations: operations.length > 0 ? operations : [{
      shell: 'powershell',
      source: command,
      executable: '',
      argv: [],
      dynamic: true,
      children: []
    }],
    ...syntax,
    diagnostics: []
  }
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
      const parseSource = shell === 'powershell'
        ? maskPowerShellParserQuirks(command)
        : maskBashWindowsPaths(command)
      const tree = (shell === 'bash' ? parsers.bash : parsers.powershell).parse(parseSource)
      if (!tree) throw new Error('Parser returned no syntax tree')
      const commandNodes = findCommandNodes(tree.rootNode)
      const operations: NormalizedOperation[] = commandNodes.map((node) => {
        const source = command.slice(node.startIndex, node.endIndex).trim()
        const rawArgv = tokenizeWords(source, shell)
        const argv = shell === 'powershell' && ['&', '.'].includes(rawArgv[0])
          ? rawArgv.slice(1)
          : shell === 'bash'
            ? stripLeadingBashAssignments(rawArgv)
            : rawArgv
        return {
          shell,
          source,
          executable: argv[0] || '',
          argv,
          dynamic: argv.length === 0 || /[$()`]/.test(argv[0] || '') || hasDynamicShellWrapperBody(argv),
          children: []
        }
      })
      const syntax = scanSyntax(command)
      if (shell === 'powershell' && tree.rootNode.hasError) {
        const native = await parseWithNativePowerShell(command)
        if (native) return native
      }
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
