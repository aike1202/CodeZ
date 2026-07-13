import { ShellAnalysisService } from '../services/permission/ShellAnalysisService'
import { normalizeExecutableName } from '../services/permission/executableName'
import type { PermissionShellKind } from '../services/permission/operationTypes'

const analysis = new ShellAnalysisService()

const DIRECT_MUTATORS = new Set([
  'apply_patch',
  'touch',
  'mkdir',
  'md',
  'mktemp',
  'rm',
  'rmdir',
  'del',
  'erase',
  'mv',
  'move',
  'cp',
  'copy',
  'ln',
  'tee',
  'dd',
  'truncate',
  'chmod',
  'chown',
  'new-item',
  'ni',
  'set-content',
  'sc',
  'add-content',
  'ac',
  'out-file',
  'remove-item',
  'ri',
  'move-item',
  'mi',
  'copy-item',
  'cpi',
  'rename-item',
  'rni',
  'clear-content',
  'set-item',
])

const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh', 'powershell', 'pwsh', 'cmd'])
const SAFE_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'grep', 'ls-files'])
const MUTATING_FLAGS = new Set([
  '--fix',
  '--fix-dry-run',
  '--write',
  '--in-place',
  '--apply',
  '--update',
  '--update-snapshots',
  '--updatesnapshot',
  '--update-snapshot',
])
const VERIFICATION_OUTPUT_FLAGS = new Set([
  '-o',
  '--output',
  '--output-file',
  '--outputfile',
  '--output-dir',
  '--outputdir',
  '--out-file',
  '--outfile',
  '--out-dir',
  '--outdir',
  '--declaration-dir',
  '--declarationdir',
  '--tsbuildinfofile',
  '--generate-trace',
  '--generatetrace',
  '--cache-location',
  '--cache-directory',
  '--coverage-directory',
  '--coverage.reportsdirectory',
  '--reports-directory',
  '--report-dir',
  '--junitxml',
  '--junit-xml',
  '--basetemp',
  '--html-report',
  '--xml-report',
  '--txt-report',
  '--cobertura-xml-report',
])
const SAFE_PACKAGE_SCRIPTS = /^(?:test|typecheck|check|lint|build|verify|validate|ci|smoke|unit|integration|e2e|coverage|dev|start|serve|preview)(?::[a-z0-9_.-]+)*$/i
const MUTATING_SCRIPT_NAME = /(?:^|[:._-])(?:fix|write|update|snapshot|generate|codegen)(?:$|[:._-])/i
const SAFE_PACKAGE_BINARIES = new Set([
  'vitest', 'jest', 'mocha', 'ava', 'tap', 'tsc', 'eslint', 'prettier', 'playwright',
])
const READ_ONLY_EXECUTABLES = new Set([
  'ls', 'dir', 'pwd', 'which', 'where', 'cat', 'head', 'tail', 'grep', 'rg', 'ripgrep',
  'findstr', 'get-content', 'get-childitem', 'get-location', 'test-path', 'select-string',
  'measure-object', 'select-object', 'format-table', 'format-list', 'compare-object',
  'get-filehash', 'resolve-path', 'stat', 'file', 'realpath', 'wc',
  'cut', 'jq', 'echo', 'printf', 'write-output', 'chcp', 'find',
])
const VERIFICATION_EXECUTABLES = new Set([
  'vitest', 'jest', 'mocha', 'ava', 'tap', 'pytest', 'tsc', 'eslint', 'prettier',
  'playwright', 'mypy', 'pylint', 'vite', 'electron-vite', 'make', 'cmake', 'ninja',
  'msbuild', 'xbuild', 'bazel', 'bazelisk', 'buck', 'buck2', 'meson', 'xcodebuild',
])
const FIND_WRITE_ACTIONS = new Set([
  '-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls',
])

function commandFromArgs(args: unknown): string {
  const value = args as Record<string, unknown> | null
  const command = value?.command ?? value?.commandLine ?? value?.CommandLine
  return typeof command === 'string' ? command.trim() : ''
}

function isMutatingFlag(argument: string): boolean {
  const normalized = argument.toLowerCase()
  return normalized === '-u' || MUTATING_FLAGS.has(normalized.split('=', 1)[0])
}

function isSnapshotMutationFlag(argument: string): boolean {
  const normalized = argument.toLowerCase().split('=', 1)[0]
  return normalized === '-u' || [
    '--update', '--updatesnapshot', '--update-snapshot', '--update-snapshots'
  ].includes(normalized)
}

function isVerificationOutputFlag(argument: string): boolean {
  const normalized = argument.toLowerCase().split(/[=:]/, 1)[0]
  return VERIFICATION_OUTPUT_FLAGS.has(normalized) || /^-o[^-]/.test(normalized)
}

function stripSafePowerShellEncodingSetup(command: string): string {
  return command
    .replace(
      /\[\s*Console\s*\]\s*::\s*(?:InputEncoding|OutputEncoding)\s*=\s*\[\s*System\.Text\.UTF8Encoding\s*\]\s*::\s*new\s*\(\s*\$false\s*\)/gi,
      '',
    )
    .replace(
      /\$OutputEncoding\s*=\s*\[\s*System\.Text\.UTF8Encoding\s*\]\s*::\s*new\s*\(\s*\$false\s*\)/gi,
      '',
    )
}

function powerShellExpressionDenial(command: string): string | null {
  const source = stripSafePowerShellEncodingSetup(command)
  let quote: "'" | '"' | null = null
  let escaped = false
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
    if (quote === "'") {
      if (char === "'" && source[index + 1] === "'") index++
      else if (char === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = null
      else if (char === '$' && source[index + 1] === '(') {
        return 'PowerShell expandable strings may not contain subexpressions.'
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === ':' && source[index + 1] === ':') {
      return 'PowerShell static member access is not allowed in review verification.'
    }
    if (char === '(' || char === ')' || char === '{' || char === '}') {
      return 'PowerShell expressions and script blocks are not allowed in review verification.'
    }
  }
  return null
}

function isDiscardRedirectTarget(target: string): boolean {
  const normalized = target.trim().replace(/^['"]|['"]$/g, '').replace(/[;,]+$/, '').toLowerCase()
  return ['/dev/null', 'nul', '$null', '&1', '&2'].includes(normalized)
}

function packageScript(argv: string[], executable: string): string {
  const args = argv.slice(1).map(argument => argument.toLowerCase())
  if (['npm', 'pnpm'].includes(executable) && args[0] === 'run') return args[1] || ''
  if (['yarn', 'bun'].includes(executable) && args[0] === 'run') return args[1] || ''
  return args[0] || ''
}

function packageCommandDenial(argv: string[], executable: string): string | null {
  const script = packageScript(argv, executable)
  if (!script) return 'package-manager command is missing a verification script or command.'
  const lowerArgs = argv.slice(1).map(argument => argument.toLowerCase())
  if (lowerArgs.some(isSnapshotMutationFlag)) {
    return 'package verification commands may not update test snapshots.'
  }
  if (lowerArgs.some(isVerificationOutputFlag)) {
    return 'package verification commands may not select a file-output path.'
  }
  if (lowerArgs.some(isMutatingFlag)) return 'package verification commands may not use mutating flags.'
  if (MUTATING_SCRIPT_NAME.test(script)) {
    return `package script '${script}' is named as a mutating workflow.`
  }
  if (SAFE_PACKAGE_SCRIPTS.test(script) || SAFE_PACKAGE_BINARIES.has(script)) return null
  return `package-manager command '${script}' is not an approved verification or development script.`
}

function gitCommandDenial(lowerArgs: string[]): string | null {
  const subcommand = lowerArgs[0] || ''
  if (!SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
    return `Git subcommand '${subcommand || '(missing)'}' is not read-only.`
  }
  if (lowerArgs.some((argument, index) =>
    argument === '--output' || argument.startsWith('--output=') ||
    (argument === '-o' && index > 0) ||
    argument === '--ext-diff' || argument.startsWith('--open-files-in-pager')
  )) {
    return 'Git output or external-command flags are not allowed in review verification.'
  }
  return null
}

function verificationCommandDenial(executable: string, lowerArgs: string[]): string | null {
  if (['vitest', 'jest'].includes(executable) && lowerArgs.includes('-u')) {
    return 'snapshot update mode is not allowed.'
  }
  if (executable === 'prettier' && !lowerArgs.some(argument =>
    argument === '--check' || argument === '--list-different'
  )) {
    return 'Prettier is allowed only in --check or --list-different mode.'
  }
  if (lowerArgs.some(isVerificationOutputFlag)) {
    return `${executable} file-output options are not allowed.`
  }
  return null
}

function networkCheckDenial(executable: string, argv: string[]): string | null {
  const args = argv.slice(1)
  const lowerArgs = args.map(argument => argument.toLowerCase())
  if (executable === 'curl' && args.some((argument, index) => {
    const lower = argument.toLowerCase()
    return [
      '--output', '--upload-file', '--dump-header', '--config', '--cookie-jar',
      '--etag-save', '--trace', '--trace-ascii', '--stderr'
    ].includes(lower) ||
      lower.startsWith('--remote-name') || lower.startsWith('--output=') ||
      lower.startsWith('--dump-header=') || lower.startsWith('--cookie-jar=') ||
      lower.startsWith('--etag-save=') || lower.startsWith('--trace=') ||
      lower.startsWith('--trace-ascii=') || lower.startsWith('--stderr=') ||
      argument === '-o' || argument === '-O' || argument === '-T' || argument === '-D' ||
      argument === '-K' || argument === '-c' ||
      /^-[A-Za-z]*[coOTDK][A-Za-z]*$/.test(argument) ||
      /^-[A-Za-z]*[coOTDK].+/.test(argument) ||
      (['-o', '-O', '-T', '-D', '-K', '-c'].includes(argument) && Boolean(args[index + 1]))
  })) {
    return 'curl file output or upload flags are not allowed.'
  }
  if (executable === 'wget') {
    const hasExplicitFileOutput = args.some((argument, index) => {
      const lower = argument.toLowerCase()
      return argument === '-o' || /^-[A-Za-z]*o.+/.test(argument) ||
        (argument === '-O' && args[index + 1] !== '-') ||
        (/^-[A-Za-z]*O.+/.test(argument) && !/^-[A-Za-z]*O-$/.test(argument)) ||
        lower === '--output-file' || lower.startsWith('--output-file=') ||
        (lower === '--output-document' && args[index + 1] !== '-') ||
        (lower.startsWith('--output-document=') && lower !== '--output-document=-')
    })
    if (hasExplicitFileOutput) return 'wget file output flags are not allowed.'
    const writesToStdout = args.some((argument, index) =>
      (argument === '-O' && args[index + 1] === '-') ||
      argument === '-O-' || /^-[A-Za-z]*O-$/.test(argument) ||
      argument.toLowerCase() === '--output-document=-'
    )
    if (!lowerArgs.includes('--spider') && !writesToStdout) {
      return 'wget is allowed only with --spider or explicit stdout output (-O -).'
    }
  }
  if (
    ['invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm'].includes(executable) &&
    lowerArgs.some(argument => /^-outf(?:i(?:l(?:e)?)?)?(?::|$)/.test(argument))
  ) {
    return `${executable} -OutFile is not allowed.`
  }
  return null
}

function operationDenial(argv: string[]): string | null {
  const executable = normalizeExecutableName(argv[0] || '')
  const lowerArgs = argv.slice(1).map(argument => argument.toLowerCase())
  if (!executable) return 'command executable could not be resolved.'
  if (DIRECT_MUTATORS.has(executable)) return `command '${executable}' can modify project files.`
  if (SHELL_WRAPPERS.has(executable)) return `nested shell '${executable}' is not allowed in review verification.`

  if (executable === 'git') {
    const denial = gitCommandDenial(lowerArgs)
    if (denial) return denial
  }

  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) {
    const denial = packageCommandDenial(argv, executable)
    if (denial) return denial
  }

  if (['npx', 'pnpx'].includes(executable)) {
    return `package executor '${executable}' may download or run an unpinned mutating tool.`
  }

  if ((executable === 'sed' || executable === 'perl') && lowerArgs.some(argument => /^-.*i/.test(argument))) {
    return `${executable} in-place editing is not allowed.`
  }
  if (['node', 'deno'].includes(executable) && lowerArgs.some(argument => ['-e', '--eval'].includes(argument))) {
    return `${executable} inline evaluation is not allowed.`
  }
  if (['python', 'python3', 'py'].includes(executable) && lowerArgs.includes('-c')) {
    return `${executable} inline evaluation is not allowed.`
  }
  if (lowerArgs.some(isMutatingFlag)) {
    return 'mutating formatter, linter, or snapshot-update flags are not allowed.'
  }

  if (executable === 'find' && lowerArgs.some(argument =>
    FIND_WRITE_ACTIONS.has(argument) ||
    argument.startsWith('-fprint') ||
    argument.startsWith('-fprintf') ||
    argument.startsWith('-fls')
  )) {
    return 'find write or command-execution actions are not allowed.'
  }
  if (['rg', 'ripgrep'].includes(executable) && lowerArgs.some(argument =>
    argument === '--pre' || argument.startsWith('--pre=')
  )) {
    return 'ripgrep preprocessor execution is not allowed.'
  }
  if (
    READ_ONLY_EXECUTABLES.has(executable) ||
    executable === 'git' ||
    ['npm', 'pnpm', 'yarn', 'bun'].includes(executable)
  ) return null
  if (VERIFICATION_EXECUTABLES.has(executable)) {
    return verificationCommandDenial(executable, lowerArgs)
  }
  if (['curl', 'wget', 'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm'].includes(executable)) {
    return networkCheckDenial(executable, argv)
  }
  return `command '${executable}' is not in the Reviewer verification allowlist.`
}

export async function checkReviewerShellCommand(
  toolName: 'Bash' | 'PowerShell',
  args: unknown,
): Promise<string | null> {
  const command = commandFromArgs(args)
  if (!command) return 'Reviewer shell command is empty or missing.'
  if (toolName === 'PowerShell') {
    const expressionDenial = powerShellExpressionDenial(command)
    if (expressionDenial) return `Reviewer shell command denied: ${expressionDenial}`
  }
  const shell: PermissionShellKind = toolName === 'PowerShell' ? 'powershell' : 'bash'
  const graph = await analysis.parse(shell, command)
  if (graph.diagnostics.length > 0) {
    return `Reviewer shell command could not be parsed safely: ${graph.diagnostics.join(', ')}.`
  }
  const writeRedirect = graph.redirects.find(redirect =>
    redirect.operator !== '<' && !isDiscardRedirectTarget(redirect.target)
  )
  if (writeRedirect) {
    return `Reviewer shell output redirection '${writeRedirect.operator} ${writeRedirect.target}' may modify a file.`
  }
  for (const operation of graph.operations) {
    if (operation.dynamic) {
      return `Reviewer shell command is dynamic and cannot be proven non-mutating: ${operation.source}`
    }
    const denial = operationDenial(operation.argv)
    if (denial) return `Reviewer shell command denied: ${denial}`
  }
  return null
}
