import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

type SourceReference = {
  file: string
  line: number
  expression: string
  channel: string | null
  declaredChannel: boolean
  derivedFromDeclaredChannel: boolean
}

type TestMigration = {
  file: string
  target: 'port-to-rust' | 'keep-frontend' | 'replace-contract' | 'replace-e2e'
  evidence: string
  reviewed: false
}

const root = process.cwd()
const outputDir = path.join(root, 'docs', 'migration', 'generated')
const sourceExtensions = new Set(['.ts', '.tsx'])

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return walk(fullPath)
    return sourceExtensions.has(path.extname(entry.name)) ? [fullPath] : []
    })
}

function relative(file: string): string {
  return path.relative(root, file).replaceAll('\\', '/')
}

function readSource(file: string): ts.SourceFile {
  const text = fs.readFileSync(file, 'utf8')
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

function propertyChain(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text
  if (!ts.isPropertyAccessExpression(node)) return null
  const parent = propertyChain(node.expression)
  return parent ? `${parent}.${node.name.text}` : null
}

function loadDeclaredChannels(): Map<string, string> {
  const file = path.join(root, 'src', 'shared', 'ipc', 'channels.ts')
  const source = readSource(file)
  const channels = new Map<string, string>()

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'IPC_CHANNELS') {
      let initializer = node.initializer
      if (initializer && ts.isAsExpression(initializer)) initializer = initializer.expression
      if (initializer && ts.isObjectLiteralExpression(initializer)) {
        for (const property of initializer.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer)) continue
          const name = property.name.getText(source).replaceAll(/["']/g, '')
          channels.set(name, property.initializer.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return channels
}

function resolveChannel(
  expression: ts.Expression | undefined,
  declaredChannels: Map<string, string>
): string | null {
  if (!expression) return null
  if (ts.isStringLiteralLike(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) {
    const chain = propertyChain(expression)
    if (chain?.startsWith('IPC_CHANNELS.')) {
      return declaredChannels.get(chain.slice('IPC_CHANNELS.'.length)) ?? null
    }
  }
  if (ts.isTemplateExpression(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.getText()
  }
  return null
}

function isDerivedFromDeclaredChannel(
  expression: ts.Expression | undefined,
  declaredChannels: Map<string, string>
): boolean {
  if (!expression || !ts.isTemplateExpression(expression) || expression.templateSpans.length === 0) {
    return false
  }
  const chain = propertyChain(expression.templateSpans[0].expression)
  return chain?.startsWith('IPC_CHANNELS.') === true &&
    declaredChannels.has(chain.slice('IPC_CHANNELS.'.length))
}

function collectContractInventory(files: string[], declaredChannels: Map<string, string>) {
  const categories: Record<string, SourceReference[]> = {
    mainRequests: [],
    mainListeners: [],
    mainEvents: [],
    rendererRequests: [],
    rendererListeners: [],
    rendererSends: [],
    rendererApiUsages: []
  }
  const declaredValues = new Set(declaredChannels.values())

  for (const file of files) {
    const source = readSource(file)

    function add(
      category: string,
      node: ts.Node,
      expression: string,
      channel: string | null,
      derivedFromDeclaredChannel = false
    ): void {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source))
      categories[category].push({
        file: relative(file),
        line: position.line + 1,
        expression,
        channel,
        declaredChannel: channel !== null && declaredValues.has(channel),
        derivedFromDeclaredChannel
      })
    }

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const callee = propertyChain(node.expression)
        const channel = resolveChannel(node.arguments[0], declaredChannels)
        const derived = isDerivedFromDeclaredChannel(node.arguments[0], declaredChannels)
        if (callee === 'ipcMain.handle' || callee === 'ipcMain.handleOnce') {
          add('mainRequests', node, callee, channel, derived)
        } else if (callee === 'ipcMain.on') {
          add('mainListeners', node, callee, channel, derived)
        } else if (callee?.endsWith('.webContents.send')) {
          add('mainEvents', node, callee, channel, derived)
        } else if (callee === 'ipcRenderer.invoke') {
          add('rendererRequests', node, callee, channel, derived)
        } else if (callee === 'ipcRenderer.on') {
          add('rendererListeners', node, callee, channel, derived)
        } else if (callee === 'ipcRenderer.send') {
          add('rendererSends', node, callee, channel, derived)
        }
      }

      if (
        ts.isPropertyAccessExpression(node) &&
        !ts.isPropertyAccessExpression(node.parent) &&
        propertyChain(node)?.startsWith('window.api.')
      ) {
        add('rendererApiUsages', node, propertyChain(node) ?? node.getText(source), null)
      }
      ts.forEachChild(node, visit)
    }

    visit(source)
  }

  return {
    declaredChannels: Object.fromEntries(declaredChannels),
    categories,
    undeclaredTransportReferences: Object.values(categories)
      .flat()
      .filter((entry) =>
        entry.channel !== null &&
        !entry.declaredChannel &&
        !entry.derivedFromDeclaredChannel
      )
  }
}

function collectPersistenceLiterals(files: string[]) {
  const entries: Array<{ file: string; line: number; value: string }> = []
  const pattern = /(?:\.jsonl?|\.secure|\.codez(?:-cache)?(?:[\\/]|$)|userData)/i

  for (const file of files) {
    const source = readSource(file)
    function visit(node: ts.Node): void {
      if (ts.isStringLiteralLike(node) && pattern.test(node.text)) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source))
        entries.push({ file: relative(file), line: position.line + 1, value: node.text })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  return entries.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
}

function classifyTests(testFiles: string[]): TestMigration[] {
  return testFiles.map((file) => {
    const text = fs.readFileSync(file, 'utf8')
    let target: TestMigration['target'] = 'port-to-rust'
    let evidence = 'Backend behavior or domain logic requires Rust equivalent coverage.'

    if (/src[\\/]renderer|react|zustand|renderHook|@testing-library/.test(text)) {
      target = 'keep-frontend'
      evidence = 'Renderer/store behavior remains in React and TypeScript.'
    } else if (/ipcMain|ipcRenderer|contextBridge|preload|electron/.test(text)) {
      target = 'replace-contract'
      evidence = 'Electron IPC or preload behavior requires typed contract coverage.'
    } else if (/BrowserWindow|window-control|TerminalService|nativeTheme|globalShortcut/.test(text)) {
      target = 'replace-e2e'
      evidence = 'Desktop host behavior requires Tauri integration or E2E coverage.'
    }

    return { file: relative(file), target, evidence, reviewed: false }
  })
}

function csvCell(value: string | number | boolean): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function writeCsv(file: string, headers: string[], rows: Array<Array<string | number | boolean>>): void {
  const content = [headers, ...rows]
    .map((row) => row.map(csvCell).join(','))
    .join('\n')
  fs.writeFileSync(file, `${content}\n`, 'utf8')
}

function generateTraceability(): Array<[string, string, string, string, string]> {
  const requirementFile = path.join(
    root,
    'docs',
    'superpowers',
    'specs',
    '2026-07-15-tauri-rust-refactor-requirements.md'
  )
  const lines = fs.readFileSync(requirementFile, 'utf8').split(/\r?\n/)
  const rows: Array<[string, string, string, string, string]> = []
  let nfrGroup: string | null = null
  let nfrIndex = 0

  for (const line of lines) {
    const fr = line.match(/^- \*\*((FR-[A-Z]+-\d+))\*\*\s+(.+)$/)
    if (fr) rows.push([fr[1], fr[3], 'pending', '', ''])

    const nfrHeading = line.match(/^### (NFR-[A-Z]+)\s+(.+)$/)
    if (nfrHeading) {
      nfrGroup = nfrHeading[1]
      nfrIndex = 0
      continue
    }
    if (nfrGroup && line.startsWith('- ')) {
      nfrIndex += 1
      rows.push([
        `${nfrGroup}-${String(nfrIndex).padStart(2, '0')}`,
        line.slice(2),
        'pending',
        '',
        ''
      ])
    }
    if (nfrGroup && line.startsWith('## ')) nfrGroup = null
  }

  return rows
}

fs.mkdirSync(outputDir, { recursive: true })

const declaredChannels = loadDeclaredChannels()
const transportFiles = [
  ...walk(path.join(root, 'src', 'main')),
  ...walk(path.join(root, 'src', 'preload')),
  ...walk(path.join(root, 'src', 'renderer', 'src'))
]
const mainFiles = walk(path.join(root, 'src', 'main'))
const testFiles = walk(path.join(root, 'src', 'tests')).filter((file) => file.endsWith('.test.ts'))
const contracts = collectContractInventory(transportFiles, declaredChannels)
const persistence = collectPersistenceLiterals(mainFiles)
const tests = classifyTests(testFiles)
const traceability = generateTraceability()

fs.writeFileSync(
  path.join(outputDir, 'desktop-contracts.json'),
  `${JSON.stringify(contracts, null, 2)}\n`,
  'utf8'
)
fs.writeFileSync(
  path.join(outputDir, 'persistence-literals.json'),
  `${JSON.stringify({ entries: persistence }, null, 2)}\n`,
  'utf8'
)
writeCsv(
  path.join(outputDir, 'test-migration.csv'),
  ['file', 'target', 'evidence', 'reviewed'],
  tests.map((test) => [test.file, test.target, test.evidence, test.reviewed])
)
writeCsv(
  path.join(outputDir, 'traceability.csv'),
  ['requirement', 'summary', 'status', 'evidence', 'platforms'],
  traceability
)

const categoryCounts = Object.fromEntries(
  Object.entries(contracts.categories).map(([category, entries]) => [category, entries.length])
)
const testCounts = tests.reduce<Record<string, number>>((counts, test) => {
  counts[test.target] = (counts[test.target] ?? 0) + 1
  return counts
}, {})
const summary = `# Tauri migration inventory\n\n` +
  `Generated by \`npm run analyze:tauri-migration\`. Generated files are evidence inputs and still require semantic review.\n\n` +
  `- Declared IPC channels: ${declaredChannels.size}\n` +
  `- Undeclared transport references: ${contracts.undeclaredTransportReferences.length}\n` +
  `- Persistence literals: ${persistence.length}\n` +
  `- Test files classified: ${tests.length}\n` +
  `- Traceability rows: ${traceability.length}\n\n` +
  `## Transport references\n\n` +
  Object.entries(categoryCounts).map(([key, count]) => `- ${key}: ${count}`).join('\n') +
  `\n\n## Initial test targets\n\n` +
  Object.entries(testCounts).map(([key, count]) => `- ${key}: ${count}`).join('\n') +
  `\n`

fs.writeFileSync(path.join(outputDir, 'inventory-summary.md'), summary, 'utf8')

console.log(summary)
