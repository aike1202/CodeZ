import * as fs from 'fs'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { ShellAnalysisService } from '../../src/main/services/permission/ShellAnalysisService'
import { normalizeExecutableName } from '../../src/main/services/permission/executableName'
import type { PermissionShellKind } from '../../src/main/services/permission/operationTypes'

interface CorpusEntry {
  id: string
  shell: Extract<PermissionShellKind, 'bash' | 'powershell'>
  expectedValid: boolean
  command: string
}

interface NormalizedResult {
  valid: boolean
  executables: string[]
  dynamic: boolean[]
}

interface RustResult {
  id: string
  shell: CorpusEntry['shell']
  hasError: boolean
  operations: Array<{ executable: string; dynamic: boolean }>
}

const workspaceRoot = process.cwd()
const corpusPath = path.join(workspaceRoot, 'src', 'tests', 'fixtures', 'permission-shell-corpus.json')
const outputPath = path.join(workspaceRoot, 'docs', 'migration', 'generated', 'shell-parser-diff.json')

function readCorpus(): CorpusEntry[] {
  const parsed = JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as unknown
  if (!Array.isArray(parsed)) throw new Error('Shell parser corpus must be an array.')
  const entries = parsed.map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`Corpus entry ${index} must be an object.`)
    const entry = value as Partial<CorpusEntry>
    if (
      typeof entry.id !== 'string'
      || (entry.shell !== 'bash' && entry.shell !== 'powershell')
      || typeof entry.expectedValid !== 'boolean'
      || typeof entry.command !== 'string'
    ) {
      throw new Error(`Corpus entry ${index} has an invalid shape.`)
    }
    return entry as CorpusEntry
  })
  const ids = new Set(entries.map((entry) => entry.id))
  if (ids.size !== entries.length) throw new Error('Shell parser corpus IDs must be unique.')
  return entries
}

function rustResults(): RustResult[] {
  const executable = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
  const result = spawnSync(executable, [
    'run',
    '--quiet',
    '--locked',
    '-p',
    'codez-platform',
    '--example',
    'shell_parser_spike',
    '--',
    corpusPath
  ], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env: { ...process.env, CARGO_TERM_COLOR: 'never' },
    maxBuffer: 10 * 1024 * 1024
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Rust shell parser spike failed (${result.status}): ${result.stderr.trim()}`)
  }
  return JSON.parse(result.stdout) as RustResult[]
}

function normalizeCurrent(graph: Awaited<ReturnType<ShellAnalysisService['parse']>>): NormalizedResult {
  return {
    valid: graph.diagnostics.length === 0,
    executables: graph.operations.map((operation) => normalizeExecutableName(operation.executable)),
    dynamic: graph.operations.map((operation) => operation.dynamic)
  }
}

function normalizeRust(result: RustResult): NormalizedResult {
  return {
    valid: !result.hasError,
    executables: result.operations.map((operation) => operation.executable),
    dynamic: result.operations.map((operation) => operation.dynamic)
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function main(): Promise<void> {
  const corpus = readCorpus()
  const rust = rustResults()
  if (rust.length !== corpus.length) {
    throw new Error(`Rust returned ${rust.length} results for ${corpus.length} corpus entries.`)
  }
  const rustById = new Map(rust.map((result) => [result.id, result]))
  if (rustById.size !== rust.length) throw new Error('Rust shell parser result IDs must be unique.')
  const parser = new ShellAnalysisService()
  const entries = []

  for (const item of corpus) {
    const rustRaw = rustById.get(item.id)
    if (!rustRaw || rustRaw.shell !== item.shell) {
      throw new Error(`Rust result is missing or mismatched for ${item.id}.`)
    }
    const currentGraph = await parser.parse(item.shell, item.command)
    const current = normalizeCurrent(currentGraph)
    const rust = normalizeRust(rustRaw)
    const differences: string[] = []
    if (current.valid !== item.expectedValid) differences.push('current-expected-validity')
    if (rust.valid !== item.expectedValid) differences.push('rust-expected-validity')
    if (current.valid !== rust.valid) differences.push('syntax-validity')
    if (!same(current.executables, rust.executables)) differences.push('executables')
    if (!same(current.dynamic, rust.dynamic)) differences.push('dynamic-flags')
    entries.push({
      id: item.id,
      shell: item.shell,
      expectedValid: item.expectedValid,
      command: item.command,
      current: {
        ...current,
        diagnostics: currentGraph.diagnostics
      },
      rust,
      differences
    })
  }

  const report = {
    versions: {
      treeSitter: '0.25.10',
      bashGrammar: '0.25.0',
      powershellGrammar: '0.25.10'
    },
    summary: {
      total: entries.length,
      exactMatches: entries.filter((entry) => entry.differences.length === 0).length,
      currentExpectationMismatches: entries.filter((entry) => entry.differences.includes('current-expected-validity')).length,
      rustExpectationMismatches: entries.filter((entry) => entry.differences.includes('rust-expected-validity')).length,
      syntaxValidityDifferences: entries.filter((entry) => entry.differences.includes('syntax-validity')).length,
      executableDifferences: entries.filter((entry) => entry.differences.includes('executables')).length,
      dynamicFlagDifferences: entries.filter((entry) => entry.differences.includes('dynamic-flags')).length,
      byShell: Object.fromEntries(['bash', 'powershell'].map((shell) => {
        const shellEntries = entries.filter((entry) => entry.shell === shell)
        return [shell, {
          total: shellEntries.length,
          exactMatches: shellEntries.filter((entry) => entry.differences.length === 0).length,
          mismatches: shellEntries.filter((entry) => entry.differences.length > 0).length
        }]
      }))
    },
    entries
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(report.summary, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
