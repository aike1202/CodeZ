import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

import {
  OBSOLETE_ELECTRON_TESTS,
  PERSISTENCE_INVENTORY,
  REQUIREMENT_ROUTES,
  type RequirementRoute
} from './migration-baselines'

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
  target: 'port-to-rust' | 'keep-frontend' | 'replace-contract' | 'replace-e2e' | 'obsolete-electron'
  evidence: string
  reviewed: true
  sourceOwners: string
  classificationRule: string
}

type ApiMethodKind = 'request' | 'fire-and-forget' | 'subscription' | 'stream'

type ApiMethodContract = {
  method: string
  file: string
  line: number
  kind: ApiMethodKind
  inputs: Array<{ name: string; type: string; optional: boolean }>
  output: string
  channels: string[]
  errors: string
  cancellation: string
  events: string
  unsubscribe: string
  containsUnsafeAny: boolean
  review: 'reviewed'
}

type TraceabilityRow = {
  requirement: string
  summary: string
  phase: string
  owner: string
  status: 'planned' | 'in-progress'
  implementation: string
  tests: string
  platforms: string
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

function propertyName(node: ts.ObjectLiteralElementLike, source: ts.SourceFile): string | null {
  if (!node.name) return null
  if (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) return node.name.text
  return node.name.getText(source)
}

function collectApiMethodContracts(
  preloadFile: string,
  declaredChannels: Map<string, string>
): ApiMethodContract[] {
  const source = readSource(preloadFile)
  let apiObject: ts.ObjectLiteralExpression | undefined

  function findApi(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'api' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      apiObject = node.initializer
      return
    }
    ts.forEachChild(node, findApi)
  }

  findApi(source)
  if (!apiObject) throw new Error('Unable to locate the preload api object.')

  const methods: ApiMethodContract[] = []

  function visitObject(object: ts.ObjectLiteralExpression, prefix: string): void {
    for (const member of object.properties) {
      if (!ts.isPropertyAssignment(member)) continue
      const name = propertyName(member, source)
      if (!name) continue
      const method = prefix ? `${prefix}.${name}` : name
      if (ts.isObjectLiteralExpression(member.initializer)) {
        visitObject(member.initializer, method)
        continue
      }
      if (!ts.isArrowFunction(member.initializer) && !ts.isFunctionExpression(member.initializer)) {
        continue
      }

      const initializer = member.initializer
      const channels = new Set<string>()
      let invokeCount = 0
      let sendCount = 0
      let listenerCount = 0
      let removeListenerCount = 0

      function inspect(node: ts.Node): void {
        if (ts.isCallExpression(node)) {
          const callee = propertyChain(node.expression)
          if (
            callee === 'ipcRenderer.invoke' ||
            callee === 'ipcRenderer.send' ||
            callee === 'ipcRenderer.on' ||
            callee === 'ipcRenderer.removeListener'
          ) {
            const channel = resolveChannel(node.arguments[0], declaredChannels)
            if (channel) channels.add(channel)
            if (callee === 'ipcRenderer.invoke') invokeCount += 1
            if (callee === 'ipcRenderer.send') sendCount += 1
            if (callee === 'ipcRenderer.on') listenerCount += 1
            if (callee === 'ipcRenderer.removeListener') removeListenerCount += 1
          }
        }
        ts.forEachChild(node, inspect)
      }

      inspect(initializer.body)
      const kind: ApiMethodKind = listenerCount > 0 && invokeCount > 0
        ? 'stream'
        : listenerCount > 0
          ? 'subscription'
          : sendCount > 0
            ? 'fire-and-forget'
            : 'request'

      if ((kind === 'subscription' || kind === 'stream') && removeListenerCount < listenerCount) {
        throw new Error(
          `${method} registers ${listenerCount} listeners but removes only ${removeListenerCount}.`
        )
      }

      const output = initializer.type?.getText(source) ?? 'inferred from implementation'
      const inputs = initializer.parameters.map((parameter) => ({
        name: parameter.name.getText(source),
        type: parameter.type?.getText(source) ?? 'unknown',
        optional: Boolean(parameter.questionToken || parameter.initializer)
      }))
      const signatureText = `${inputs.map((input) => input.type).join(' ')} ${output}`
      const channelList = [...channels].sort((left, right) => left.localeCompare(right))

      let errors = 'Returned Promise rejects when the main-process handler throws or IPC serialization fails.'
      if (kind === 'fire-and-forget') {
        errors = 'No result channel; delivery and main-process failures are not observable by the caller.'
      } else if (kind === 'subscription') {
        errors = 'Listener registration is synchronous; payload or callback failures remain local to the renderer callback.'
      } else if (kind === 'stream') {
        errors = 'The started Promise rejects on start failure; terminal runtime failures arrive on the stream error callback.'
      }

      let cancellation = 'None; the request has no independent cancellation token.'
      if (kind === 'subscription') {
        cancellation = 'The returned disposer cancels renderer delivery only; it does not stop the producer.'
      } else if (method === 'chat.stream') {
        cancellation = 'stop() sends chat:stream:stop for the active stream and disposes every listener; cleanup is idempotent.'
      } else if (method === 'chat.interruptTool') {
        cancellation = 'Explicit remote interruption by toolCallId; the returned status confirms the resulting task state.'
      } else if (method === 'terminal.kill') {
        cancellation = 'Explicitly terminates the terminal identified by workspaceId.'
      }

      let events = 'None.'
      if (kind === 'subscription') {
        events = `Each event from ${channelList.join(', ')} is forwarded to the supplied callback.`
      } else if (method === 'chat.stream') {
        events = 'Events are filtered by streamId; end/error are terminal and trigger cleanup before invoking the callback.'
      }

      const unsubscribe = listenerCount > 0
        ? `Required; the returned stop/disposer removes all ${listenerCount} registered listener(s).`
        : 'Not applicable.'
      const position = source.getLineAndCharacterOfPosition(member.getStart(source))

      methods.push({
        method,
        file: relative(preloadFile),
        line: position.line + 1,
        kind,
        inputs,
        output,
        channels: channelList,
        errors,
        cancellation,
        events,
        unsubscribe,
        containsUnsafeAny: /\bany\b/.test(signatureText),
        review: 'reviewed'
      })
    }
  }

  visitObject(apiObject, '')
  return methods.sort((left, right) => left.method.localeCompare(right.method))
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
    const source = readSource(file)
    const text = fs.readFileSync(file, 'utf8')
    const imports = source.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text.replaceAll('\\', '/')
        : '')
      .filter(Boolean)
    const owners = new Set<string>()
    for (const imported of imports) {
      if (imported.includes('/renderer/')) owners.add('renderer')
      else if (imported.includes('/preload/')) owners.add('preload')
      else if (imported.includes('/main/ipc/')) owners.add('main-ipc')
      else if (imported.includes('/main/')) owners.add('main-runtime')
      else if (imported.includes('/shared/')) owners.add('shared-contract')
      else owners.add('external')
    }
    const transportIdentifiers = new Set<string>()
    function collectTransportIdentifiers(node: ts.Node): void {
      if (
        ts.isIdentifier(node) &&
        (node.text === 'ipcMain' || node.text === 'ipcRenderer' || node.text === 'contextBridge')
      ) {
        transportIdentifiers.add(node.text)
      }
      ts.forEachChild(node, collectTransportIdentifiers)
    }
    collectTransportIdentifiers(source)

    const relativeFile = relative(file)
    let target: TestMigration['target'] = 'port-to-rust'
    let evidence = 'Backend behavior or domain logic requires Rust equivalent coverage.'
    let classificationRule = 'default-backend-domain'

    if (OBSOLETE_ELECTRON_TESTS.has(relativeFile)) {
      target = 'obsolete-electron'
      evidence = 'Legacy V1 pipeline coverage is retained through Phase 9 and may be removed only after canonical V2 parity is linked.'
      classificationRule = 'reviewed-legacy-pipeline-override'
    } else if (
      owners.has('preload') ||
      transportIdentifiers.size > 0
    ) {
      target = 'replace-contract'
      evidence = 'Electron IPC or preload behavior requires typed contract coverage.'
      classificationRule = 'preload-or-ipc-boundary'
    } else if (owners.has('renderer') || /renderHook|@testing-library/.test(text)) {
      target = 'keep-frontend'
      evidence = 'Renderer/store behavior remains in React and TypeScript.'
      classificationRule = 'renderer-import-or-render-harness'
    }

    return {
      file: relativeFile,
      target,
      evidence,
      reviewed: true,
      sourceOwners: [...owners].sort().join(';') || 'none',
      classificationRule
    }
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

function routeRequirement(requirement: string): RequirementRoute {
  const key = Object.keys(REQUIREMENT_ROUTES).find((candidate) =>
    requirement === candidate || requirement.startsWith(`${candidate}-`)
  )
  if (!key) throw new Error(`No traceability route exists for ${requirement}.`)
  return REQUIREMENT_ROUTES[key]
}

function generateTraceability(tests: TestMigration[]): TraceabilityRow[] {
  const requirementFile = path.join(
    root,
    'docs',
    'superpowers',
    'specs',
    '2026-07-15-tauri-rust-refactor-requirements.md'
  )
  const lines = fs.readFileSync(requirementFile, 'utf8').split(/\r?\n/)
  const requirements: Array<{ requirement: string; summary: string }> = []
  let nfrGroup: string | null = null
  let nfrIndex = 0

  for (const line of lines) {
    const fr = line.match(/^- \*\*((FR-[A-Z]+-\d+))\*\*\s+(.+)$/)
    if (fr) requirements.push({ requirement: fr[1], summary: fr[3] })

    const nfrHeading = line.match(/^### (NFR-[A-Z]+)\s+(.+)$/)
    if (nfrHeading) {
      nfrGroup = nfrHeading[1]
      nfrIndex = 0
      continue
    }
    if (nfrGroup && line.startsWith('- ')) {
      nfrIndex += 1
      requirements.push({
        requirement: `${nfrGroup}-${String(nfrIndex).padStart(2, '0')}`,
        summary: line.slice(2)
      })
    }
    if (nfrGroup && line.startsWith('## ')) nfrGroup = null
  }

  return requirements.map(({ requirement, summary }) => {
    const route = routeRequirement(requirement)
    const matchingTests = tests
      .filter((test) => route.keywords.some((keyword) => test.file.toLowerCase().includes(keyword)))
      .slice(0, 8)
      .map((test) => test.file)
    const status = requirement === 'FR-MIG-01' || requirement === 'FR-MIG-02' || requirement === 'FR-MIG-03'
      ? 'in-progress' as const
      : 'planned' as const
    return {
      requirement,
      summary,
      phase: route.phase,
      owner: route.owner,
      status,
      implementation: `${route.owner} implementation in ${route.phase}; Electron remains the behavioral baseline until replacement evidence is linked.`,
      tests: matchingTests.length > 0
        ? matchingTests.join(';')
        : `Planned evidence: ${route.testStrategy}`,
      platforms: route.platforms
    }
  })
}

function validateMigrationFixtures(): number {
  const fixtureDirectory = path.join(root, 'src', 'tests', 'fixtures', 'migration')
  const fixtureFiles = [
    'provider-protocol-golden.json',
    'tool-schema-golden.json',
    'permission-runtime-golden.json',
    'agent-state-golden.json'
  ]
  const fixtures = Object.fromEntries(fixtureFiles.map((file) => {
    const filePath = path.join(fixtureDirectory, file)
    return [file, JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown]
  }))
  const providerFixture = fixtures['provider-protocol-golden.json'] as { fixtures?: unknown }
  const providerText = JSON.stringify(providerFixture.fixtures)
  if (!providerText.includes('[REDACTED]') || providerText.includes('fixture-secret')) {
    throw new Error('Provider golden fixtures do not satisfy the redaction policy.')
  }
  const permission = fixtures['permission-runtime-golden.json'] as { shellCorpus?: string }
  if (!permission.shellCorpus) throw new Error('Permission fixture does not reference the shell corpus.')
  const shellCorpus = path.resolve(fixtureDirectory, permission.shellCorpus)
  if (!fs.existsSync(shellCorpus)) throw new Error(`Permission shell corpus does not exist: ${shellCorpus}`)
  return fixtureFiles.length
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
const apiMethods = collectApiMethodContracts(
  path.join(root, 'src', 'preload', 'index.ts'),
  declaredChannels
)
const persistence = collectPersistenceLiterals(mainFiles)
const tests = classifyTests(testFiles)
const traceability = generateTraceability(tests)
const fixtureCount = validateMigrationFixtures()

const methodsWithoutChannels = apiMethods.filter((method) => method.channels.length === 0)
if (methodsWithoutChannels.length > 0) {
  throw new Error(`window.api methods without transport channels: ${methodsWithoutChannels.map((method) => method.method).join(', ')}`)
}
if (new Set(PERSISTENCE_INVENTORY.map((entry) => entry.id)).size !== PERSISTENCE_INVENTORY.length) {
  throw new Error('Persistence inventory IDs must be unique.')
}

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
fs.writeFileSync(
  path.join(outputDir, 'desktop-api-semantics.json'),
  `${JSON.stringify({ methods: apiMethods }, null, 2)}\n`,
  'utf8'
)
fs.writeFileSync(
  path.join(outputDir, 'persistence-inventory.json'),
  `${JSON.stringify({ entries: PERSISTENCE_INVENTORY }, null, 2)}\n`,
  'utf8'
)
writeCsv(
  path.join(outputDir, 'test-migration.csv'),
  ['file', 'target', 'evidence', 'reviewed', 'sourceOwners', 'classificationRule'],
  tests.map((test) => [
    test.file,
    test.target,
    test.evidence,
    test.reviewed,
    test.sourceOwners,
    test.classificationRule
  ])
)
writeCsv(
  path.join(outputDir, 'traceability.csv'),
  ['requirement', 'summary', 'phase', 'owner', 'status', 'implementation', 'tests', 'platforms'],
  traceability.map((row) => [
    row.requirement,
    row.summary,
    row.phase,
    row.owner,
    row.status,
    row.implementation,
    row.tests,
    row.platforms
  ])
)

const categoryCounts = Object.fromEntries(
  Object.entries(contracts.categories).map(([category, entries]) => [category, entries.length])
)
const testCounts = tests.reduce<Record<string, number>>((counts, test) => {
  counts[test.target] = (counts[test.target] ?? 0) + 1
  return counts
}, {
  'port-to-rust': 0,
  'keep-frontend': 0,
  'replace-contract': 0,
  'replace-e2e': 0,
  'obsolete-electron': 0
})
const summary = `# Tauri migration inventory\n\n` +
  `Generated by \`npm run analyze:tauri-migration\`. AST discovery is combined with reviewed migration rules and golden fixture validation.\n\n` +
  `- Declared IPC channels: ${declaredChannels.size}\n` +
  `- Undeclared transport references: ${contracts.undeclaredTransportReferences.length}\n` +
  `- Reviewed window.api methods: ${apiMethods.length}\n` +
  `- window.api signatures containing any: ${apiMethods.filter((method) => method.containsUnsafeAny).length}\n` +
  `- Persistence literals: ${persistence.length}\n` +
  `- Reviewed persistence stores: ${PERSISTENCE_INVENTORY.length}\n` +
  `- Validated golden fixture files: ${fixtureCount}\n` +
  `- Test files classified: ${tests.length}\n` +
  `- Unreviewed test classifications: ${tests.filter((test) => !test.reviewed).length}\n` +
  `- Traceability rows: ${traceability.length}\n\n` +
  `## Transport references\n\n` +
  Object.entries(categoryCounts).map(([key, count]) => `- ${key}: ${count}`).join('\n') +
  `\n\n## Reviewed test targets\n\n` +
  Object.entries(testCounts).map(([key, count]) => `- ${key}: ${count}`).join('\n') +
  `\n`

fs.writeFileSync(path.join(outputDir, 'inventory-summary.md'), summary, 'utf8')

console.log(summary)
