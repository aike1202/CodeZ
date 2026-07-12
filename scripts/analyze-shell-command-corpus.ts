import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'
import * as ts from 'typescript'
import { ShellAnalysisService } from '../src/main/services/permission/ShellAnalysisService'
import { classifyKnownCommand } from '../src/main/services/permission/commandPolicies'
import { normalizeExecutableName } from '../src/main/services/permission/executableName'
import type { NormalizedOperationGraph, PermissionShellKind } from '../src/main/services/permission/operationTypes'

type CommandSource = 'codez-session' | 'codez-ledger' | 'codez-audit' | 'codex' | 'claude'

interface CommandRecord {
  shell: PermissionShellKind
  command: string
  source: CommandSource
}

const userData = path.join(process.env.APPDATA || '', 'codez')
const codexRoots = [path.join(os.homedir(), '.codex', 'sessions'), path.join(os.homedir(), '.codex', 'archived_sessions')]
const claudeRoot = path.join(os.homedir(), '.claude', 'projects')
const records: CommandRecord[] = []
const toolCounts = new Map<string, Map<string, number>>()
const codexNestedToolCounts = new Map<string, number>()
const seenToolCalls = new Map<string, Set<string>>()

function increment(map: Map<string, number>, name: string): void {
  map.set(name, (map.get(name) || 0) + 1)
}

function countTool(platform: string, name: string): void {
  if (!name) return
  let counts = toolCounts.get(platform)
  if (!counts) {
    counts = new Map<string, number>()
    toolCounts.set(platform, counts)
  }
  increment(counts, name)
}

function firstToolCall(platform: string, id: unknown): boolean {
  if (typeof id !== 'string' || !id) return true
  let seen = seenToolCalls.get(platform)
  if (!seen) {
    seen = new Set<string>()
    seenToolCalls.set(platform, seen)
  }
  if (seen.has(id)) return false
  seen.add(id)
  return true
}

function parseArguments(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function shellFor(toolName: string, args: Record<string, unknown>): PermissionShellKind | null {
  const name = toolName.toLowerCase()
  if (name === 'powershell') return 'powershell'
  if (name === 'bash') return 'bash'
  if (name === 'run_command') {
    const requested = String(args.shellKind || args.shell || '').toLowerCase()
    if (requested === 'bash' || requested === 'powershell' || requested === 'cmd') return requested
    return process.platform === 'win32' ? 'cmd' : 'bash'
  }
  return null
}

function addToolCall(call: Record<string, unknown>, source: CommandRecord['source']): void {
  const fn = call.function && typeof call.function === 'object'
    ? call.function as Record<string, unknown>
    : null
  const name = String(call.name || fn?.name || '')
  if (!name) return
  if (!firstToolCall('codez', call.id)) return
  countTool('codez', name)
  const args = parseArguments(call.arguments ?? call.args ?? call.input ?? fn?.arguments)
  if (!args || typeof args.command !== 'string' || !args.command.trim()) return
  const shell = shellFor(name, args)
  if (shell) records.push({ shell, command: args.command.trim(), source })
}

function scanMessages(value: unknown, source: CommandRecord['source']): void {
  if (Array.isArray(value)) {
    for (const item of value) scanMessages(item, source)
    return
  }
  if (!value || typeof value !== 'object') return
  const object = value as Record<string, unknown>
  for (const key of ['toolCalls', 'tool_calls']) {
    const calls = object[key]
    if (Array.isArray(calls)) {
      for (const call of calls) {
        if (call && typeof call === 'object') addToolCall(call as Record<string, unknown>, source)
      }
    }
  }
  for (const [key, child] of Object.entries(object)) {
    if (key !== 'toolCalls' && key !== 'tool_calls') scanMessages(child, source)
  }
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function scanSessions(): void {
  scanMessages(readJson(path.join(userData, 'sessions.json')), 'codez-session')
}

function scanLedgers(): void {
  const root = path.join(userData, 'session-runtime')
  if (!fs.existsSync(root)) return
  for (const sessionId of fs.readdirSync(root)) {
    const ledger = path.join(root, sessionId, 'ledger.jsonl')
    if (!fs.existsSync(ledger)) continue
    for (const line of fs.readFileSync(ledger, 'utf8').split(/\r?\n/)) {
      if (!line) continue
      try {
        scanMessages(JSON.parse(line), 'codez-ledger')
      } catch {}
    }
  }
}

function scanAudit(): void {
  const filePath = path.join(userData, 'permission-audit.jsonl')
  if (!fs.existsSync(filePath)) return
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line) continue
    try {
      const event = JSON.parse(line) as Record<string, any>
      const toolName = String(event.toolName || '')
      const shell = shellFor(toolName, {})
      const command = event.decision?.normalizedPattern
      if (shell && typeof command === 'string' && command.trim()) {
        records.push({ shell, command: command.trim(), source: 'codez-audit' })
      }
    } catch {}
  }
}

function jsonlFiles(root: string): string[] {
  if (!fs.existsSync(root)) return []
  const output: string[] = []
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(fullPath)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(fullPath)
    }
  }
  visit(root)
  return output
}

function staticBindings(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const bindings = new Map<string, ts.Expression>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bindings.set(node.name.text, node.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return bindings
}

function staticString(
  node: ts.Expression | undefined,
  bindings: Map<string, ts.Expression>,
  locals: Map<string, string>,
  seen = new Set<string>()
): string | null {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isIdentifier(node)) {
    if (locals.has(node.text)) return locals.get(node.text) || ''
    if (seen.has(node.text)) return null
    const bound = bindings.get(node.text)
    if (!bound) return null
    const nextSeen = new Set(seen)
    nextSeen.add(node.text)
    return staticString(bound, bindings, locals, nextSeen)
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left, bindings, locals, seen)
    const right = staticString(node.right, bindings, locals, seen)
    return left === null || right === null ? null : left + right
  }
  if (ts.isTemplateExpression(node)) {
    let result = node.head.text
    for (const span of node.templateSpans) {
      const expression = staticString(span.expression, bindings, locals, seen)
      if (expression === null) return null
      result += expression + span.literal.text
    }
    return result
  }
  return null
}

function staticStringArray(
  node: ts.Expression | undefined,
  bindings: Map<string, ts.Expression>,
  locals: Map<string, string>
): string[] | null {
  if (!node) return null
  if (ts.isIdentifier(node)) return staticStringArray(bindings.get(node.text), bindings, locals)
  if (!ts.isArrayLiteralExpression(node)) return null
  const values = node.elements.map((element) => staticString(element as ts.Expression, bindings, locals))
  return values.every((value): value is string => value !== null) ? values : null
}

function propertyExpression(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property)) {
      const propertyName = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : ''
      if (propertyName === name) return property.initializer
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name
  }
  return undefined
}

function scanCodexExecSource(input: string): void {
  const sourceFile = ts.createSourceFile('codex-exec.ts', input, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const bindings = staticBindings(sourceFile)
  const visit = (node: ts.Node, locals = new Map<string, string>()): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'map' &&
      node.arguments.length > 0 &&
      (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))
    ) {
      const values = staticStringArray(node.expression.expression, bindings, locals)
      const callback = node.arguments[0]
      const parameter = callback.parameters[0]?.name
      if (values && parameter && ts.isIdentifier(parameter)) {
        for (const value of values) {
          const iterationLocals = new Map(locals)
          iterationLocals.set(parameter.text, value)
          visit(callback.body, iterationLocals)
        }
        return
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'tools'
    ) {
      const name = node.expression.name.text
      increment(codexNestedToolCounts, name)
      if (name === 'exec_command' && ts.isObjectLiteralExpression(node.arguments[0])) {
        const command = staticString(propertyExpression(node.arguments[0], 'cmd'), bindings, locals)
        if (command?.trim()) records.push({ shell: 'powershell', command: command.trim(), source: 'codex' })
      }
    }
    ts.forEachChild(node, (child) => visit(child, locals))
  }
  visit(sourceFile)
}

function scanCodex(): void {
  for (const filePath of codexRoots.flatMap(jsonlFiles)) {
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      if (!line) continue
      try {
        const record = JSON.parse(line) as Record<string, any>
        if (record.type !== 'response_item') continue
        const payload = record.payload
        if (!payload || !['function_call', 'custom_tool_call'].includes(payload.type)) continue
        const name = String(payload.name || '')
        if (!firstToolCall('codex', payload.call_id || payload.id)) continue
        countTool('codex', name)
        if (payload.type === 'custom_tool_call' && name === 'exec' && typeof payload.input === 'string') {
          scanCodexExecSource(payload.input)
          continue
        }
        const args = parseArguments(payload.arguments)
        if (!args) continue
        const command = typeof args.cmd === 'string' ? args.cmd : typeof args.command === 'string' ? args.command : null
        if (command?.trim() && ['exec_command', 'shell_command'].includes(name)) {
          records.push({ shell: 'powershell', command: command.trim(), source: 'codex' })
        }
      } catch {}
    }
  }
}

function scanClaude(): void {
  for (const filePath of jsonlFiles(claudeRoot)) {
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      if (!line) continue
      try {
        const record = JSON.parse(line) as Record<string, any>
        if (record.type !== 'assistant' || !Array.isArray(record.message?.content)) continue
        for (const content of record.message.content) {
          if (content?.type !== 'tool_use') continue
          const name = String(content.name || '')
          if (!firstToolCall('claude', content.id)) continue
          countTool('claude', name)
          const command = content.input?.command
          if (typeof command !== 'string' || !command.trim()) continue
          if (name === 'Bash') records.push({ shell: 'bash', command: command.trim(), source: 'claude' })
          else if (name === 'PowerShell') records.push({ shell: 'powershell', command: command.trim(), source: 'claude' })
        }
      } catch {}
    }
  }
}

function sortedCounts(counts: Map<string, number>, limit?: number): Array<[string, number]> {
  const values = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  return typeof limit === 'number' ? values.slice(0, limit) : values
}

function incrementRecord(target: Record<string, number>, key: string): void {
  target[key] = (target[key] || 0) + 1
}

function platformForSource(source: CommandSource): 'codez' | 'codex' | 'claude' {
  return source.startsWith('codez-') ? 'codez' : source
}

function incrementNestedCount(target: Map<string, Map<string, number>>, group: string, name: string): void {
  let counts = target.get(group)
  if (!counts) {
    counts = new Map<string, number>()
    target.set(group, counts)
  }
  increment(counts, name)
}

function failureFeatures(command: string): string[] {
  const features: string[] = []
  if (/(?:^|\s)--[A-Za-z]/m.test(command)) features.push('native-long-option')
  if (/(?:^|\s)--(?:\s|$)/m.test(command)) features.push('native-option-terminator')
  if (command.includes(',')) features.push('comma-argument-list')
  if (/@["']/.test(command)) features.push('here-string-or-array')
  if (/[{}]/.test(command)) features.push('script-block')
  if (command.includes('$')) features.push('powershell-expansion')
  if (/\|/.test(command)) features.push('pipeline')
  if (/\r?\n/.test(command)) features.push('multiline')
  return features.length > 0 ? features : ['other']
}

function validateWithNativePowerShell(commands: string[]): { available: boolean; valid: number; invalid: number } {
  if (process.platform !== 'win32' || commands.length === 0) return { available: false, valid: 0, invalid: 0 }
  const script = [
    '$items = [Console]::In.ReadToEnd() | ConvertFrom-Json',
    '$result = for ($index = 0; $index -lt $items.Count; $index++) {',
    '  $item = $items[$index]',
    '  $tokens = $null; $errors = $null',
    '  [System.Management.Automation.Language.Parser]::ParseInput([string]$item, [ref]$tokens, [ref]$errors) | Out-Null',
    '  [PSCustomObject]@{ valid = (@($errors).Count -eq 0) }',
    '}',
    '$result | ConvertTo-Json -Compress'
  ].join('\n')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: JSON.stringify(commands),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  })
  if (result.status !== 0 || !result.stdout.trim()) return { available: false, valid: 0, invalid: 0 }
  try {
    const parsed = JSON.parse(result.stdout)
    const entries = Array.isArray(parsed) ? parsed : [parsed]
    const valid = entries.filter((entry) => entry?.valid === true).length
    return { available: true, valid, invalid: entries.length - valid }
  } catch {
    return { available: false, valid: 0, invalid: 0 }
  }
}

function validateWithNativeBash(commands: string[]): { available: boolean; valid: number; invalid: number } {
  if (commands.length === 0) return { available: false, valid: 0, invalid: 0 }
  let available = false
  let valid = 0
  let invalid = 0
  for (const command of commands) {
    const result = spawnSync('bash', ['-n'], {
      input: command,
      encoding: 'utf8',
      env: { ...process.env, BASH_ENV: '', ENV: '' },
      timeout: 5000,
      maxBuffer: 1024 * 1024
    })
    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { available: false, valid: 0, invalid: 0 }
    }
    available = true
    if (result.status === 0) valid++
    else invalid++
  }
  return { available, valid, invalid }
}

async function main(): Promise<void> {
  const includeSamples = process.argv.includes('--samples')
  scanSessions()
  scanLedgers()
  scanAudit()
  scanCodex()
  scanClaude()

  const unique = Array.from(new Map(records.map((record) => [`${record.shell}\0${record.command}`, record])).values())
  const parser = new ShellAnalysisService()
  const failures: Array<CommandRecord & { diagnostics: string[] }> = []
  const parsedGraphs = new Map<string, NormalizedOperationGraph>()
  const shellCounts: Record<string, number> = {}
  const sourceCounts: Record<string, number> = {}
  for (const record of records) {
    shellCounts[record.shell] = (shellCounts[record.shell] || 0) + 1
    sourceCounts[record.source] = (sourceCounts[record.source] || 0) + 1
  }
  for (const record of unique) {
    const graph = await parser.parse(record.shell, record.command)
    parsedGraphs.set(`${record.shell}\0${record.command}`, graph)
    if (graph.diagnostics.length > 0) failures.push({ ...record, diagnostics: graph.diagnostics })
  }
  const executableCounts = new Map<string, Map<string, number>>()
  const unknownExecutableCounts = new Map<string, Map<string, number>>()
  for (const record of records) {
    const graph = parsedGraphs.get(`${record.shell}\0${record.command}`)
    if (!graph || graph.diagnostics.length > 0) continue
    const platform = platformForSource(record.source)
    for (const operation of graph.operations) {
      const executable = normalizeExecutableName(operation.argv[0] || '')
      if (!executable || operation.dynamic) continue
      incrementNestedCount(executableCounts, platform, executable)
      if (!classifyKnownCommand(operation.argv)) {
        incrementNestedCount(unknownExecutableCounts, platform, executable)
      }
    }
  }
  const failuresBySource: Record<string, number> = {}
  const failuresByShell: Record<string, number> = {}
  const failureFeatureCounts: Record<string, number> = {}
  for (const failure of failures) {
    incrementRecord(failuresBySource, failure.source)
    incrementRecord(failuresByShell, failure.shell)
    for (const feature of failureFeatures(failure.command)) incrementRecord(failureFeatureCounts, feature)
  }
  const nativePowerShellValidation = validateWithNativePowerShell(
    failures.filter((failure) => failure.shell === 'powershell').map((failure) => failure.command)
  )
  const nativeBashValidation = validateWithNativeBash(
    failures.filter((failure) => failure.shell === 'bash').map((failure) => failure.command)
  )

  console.log(JSON.stringify({
    dataRoots: { codez: userData, codex: codexRoots, claude: claudeRoot },
    records: records.length,
    uniqueCommands: unique.length,
    shellCounts,
    sourceCounts,
    parserFailures: failures.length,
    failureRate: unique.length > 0 ? `${(failures.length / unique.length * 100).toFixed(2)}%` : '0.00%',
    failuresBySource,
    failuresByShell,
    failureFeatureCounts,
    nativePowerShellValidation,
    nativeBashValidation,
    toolCallsByPlatform: Object.fromEntries(
      Array.from(toolCounts.entries()).map(([platform, counts]) => [platform, sortedCounts(counts)])
    ),
    codexNestedToolCalls: sortedCounts(codexNestedToolCounts),
    commandExecutablesByPlatform: Object.fromEntries(
      Array.from(executableCounts.entries()).map(([platform, counts]) => [platform, sortedCounts(counts)])
    ),
    unknownCommandExecutablesByPlatform: Object.fromEntries(
      Array.from(unknownExecutableCounts.entries()).map(([platform, counts]) => [platform, sortedCounts(counts)])
    ),
    ...(!includeSamples ? {} : {
      failureSamplesByShell: Object.fromEntries(
        (['powershell', 'bash', 'cmd'] as PermissionShellKind[]).map((shell) => [
          shell,
          failures.filter((failure) => failure.shell === shell).slice(0, 20)
        ])
      )
    })
  }, null, 2))
}

void main()
