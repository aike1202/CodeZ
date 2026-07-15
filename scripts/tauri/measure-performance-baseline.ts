import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'

import { rgPath } from '@vscode/ripgrep'
import * as pty from 'node-pty'

import { ChatProviderFactory } from '../../src/main/services/chat/ChatProviderFactory'
import { WorkspaceService } from '../../src/main/services/WorkspaceService'

const execFileAsync = promisify(execFile)
const root = process.cwd()
const outputFile = path.join(
  root,
  'docs',
  'migration',
  'generated',
  `performance-baseline.${process.platform}-${process.arch}.json`
)

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

async function measureWorkspaceTree(): Promise<{ paths: number; medianMs: number }> {
  const service = new WorkspaceService(root)
  const samples: number[] = []
  let paths = 0
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now()
    paths = (await service.getAllPaths()).length
    samples.push(performance.now() - started)
  }
  return { paths, medianMs: round(median(samples)) }
}

async function measureSearch(): Promise<{ matches: number; medianMs: number }> {
  const samples: number[] = []
  let matches = 0
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now()
    const { stdout } = await execFileAsync(rgPath, [
      '--count-matches',
      '--glob',
      '*.ts',
      '--glob',
      '*.tsx',
      'window\\.api',
      'src/renderer/src'
    ], { cwd: root, encoding: 'utf8' })
    matches = stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .reduce((total, line) => total + Number(line.split(':').pop() || 0), 0)
    samples.push(performance.now() - started)
  }
  return { matches, medianMs: round(median(samples)) }
}

async function measureSyntheticFirstToken(): Promise<{ medianMs: number; samples: number }> {
  const originalFetch = globalThis.fetch
  const samples: number[] = []
  try {
    globalThis.fetch = async () => new Response([
      'data: {"choices":[{"delta":{"content":"first"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
      ''
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })
    for (let index = 0; index < 7; index += 1) {
      const provider = ChatProviderFactory.createProvider({ apiFormat: 'openai' })
      const started = performance.now()
      let firstTokenMs: number | undefined
      await provider.streamChat({
        baseUrl: 'https://provider.example/v1',
        apiKey: '[REDACTED]',
        model: 'baseline-model',
        apiFormat: 'openai',
        messages: [{ role: 'user', content: 'baseline' }]
      }, {
        onChunk: () => { firstTokenMs ??= performance.now() - started },
        onDone: () => undefined,
        onError: (error) => { throw new Error(error) }
      }, new AbortController().signal)
      if (firstTokenMs === undefined) throw new Error('Synthetic provider returned no token.')
      samples.push(firstTokenMs)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
  return { medianMs: round(median(samples)), samples: samples.length }
}

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

async function measurePtyThroughput(): Promise<{
  bytes: number
  elapsedMs: number
  mebibytesPerSecond: number
}> {
  const targetBytes = 1024 * 1024
  const command = process.platform === 'win32'
    ? {
        executable: 'powershell.exe',
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$u=[System.Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=$u;$c='x'*4096;for($i=0;$i -lt 256;$i++){[Console]::Write($c)}"
        ]
      }
    : {
        executable: 'bash',
        args: ['--noprofile', '--norc', '-c', "head -c 1048576 /dev/zero | tr '\\0' x"]
      }

  return new Promise((resolve, reject) => {
    const started = performance.now()
    let bytes = 0
    const terminal = pty.spawn(command.executable, command.args, {
      name: 'xterm-color',
      cols: 120,
      rows: 24,
      cwd: root,
      env: stringEnvironment()
    })
    const timeout = setTimeout(() => {
      terminal.kill()
      reject(new Error('PTY throughput probe timed out.'))
    }, 20_000)
    terminal.onData((data) => { bytes += Buffer.byteLength(data, 'utf8') })
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout)
      if (exitCode !== 0) {
        reject(new Error(`PTY throughput probe exited with ${exitCode}.`))
        return
      }
      const elapsedMs = performance.now() - started
      if (bytes < targetBytes) {
        reject(new Error(`PTY throughput probe captured only ${bytes} of ${targetBytes} bytes.`))
        return
      }
      resolve({
        bytes,
        elapsedMs: round(elapsedMs),
        mebibytesPerSecond: round(bytes / 1024 / 1024 / (elapsedMs / 1000))
      })
    })
  })
}

type ElectronStartupSample = {
  didFinishLoadMs: number
  readyToShowMs: number
  firstAnimationFrameMs: number
  totalWorkingSetBytes: number
  processCount: number
  rendererResponsive: boolean
}

async function measureElectronStartupOnce(): Promise<ElectronStartupSample> {
  const executable = path.join(
    root,
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron'
  )
  const probe = path.join(root, 'scripts', 'tauri', 'electron-performance-probe.cjs')
  const temporaryUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'codez-electron-baseline-'))
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [probe], {
      cwd: root,
      env: {
        ...process.env,
        CODEZ_PERF_BASELINE: '1',
        CODEZ_PERF_USER_DATA: temporaryUserData
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const removeTemporaryUserData = async (): Promise<void> => {
      await fs.promises.rm(temporaryUserData, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200
      })
    }
    const timeout = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => undefined)
      } else {
        child.kill('SIGKILL')
      }
      void removeTemporaryUserData().finally(() => {
        reject(new Error(`Electron startup probe timed out. stdout: ${stdout} stderr: ${stderr}`))
      })
    }, 45_000)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      void removeTemporaryUserData().then(() => {
        const marker = stdout.split(/\r?\n/).find((line) => line.startsWith('CODEZ_PERF_BASELINE:'))
        if (code !== 0 || !marker) {
          reject(new Error(`Electron startup probe failed with ${code}. stdout: ${stdout} stderr: ${stderr}`))
          return
        }
        resolve(JSON.parse(marker.slice('CODEZ_PERF_BASELINE:'.length)) as ElectronStartupSample)
      }, reject)
    })
  })
}

async function measureElectronStartup(): Promise<{
  samples: ElectronStartupSample[]
  median: Omit<ElectronStartupSample, 'rendererResponsive'> & { rendererResponsive: boolean }
}> {
  const samples: ElectronStartupSample[] = []
  for (let index = 0; index < 3; index += 1) {
    samples.push(await measureElectronStartupOnce())
  }
  return {
    samples,
    median: {
      didFinishLoadMs: round(median(samples.map((sample) => sample.didFinishLoadMs))),
      readyToShowMs: round(median(samples.map((sample) => sample.readyToShowMs))),
      firstAnimationFrameMs: round(median(samples.map((sample) => sample.firstAnimationFrameMs))),
      totalWorkingSetBytes: Math.round(median(samples.map((sample) => sample.totalWorkingSetBytes))),
      processCount: Math.round(median(samples.map((sample) => sample.processCount))),
      rendererResponsive: samples.every((sample) => sample.rendererResponsive)
    }
  }
}

function directoryBytes(directory: string): number {
  if (!fs.existsSync(directory)) return 0
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const target = path.join(directory, entry.name)
    return total + (entry.isDirectory() ? directoryBytes(target) : fs.statSync(target).size)
  }, 0)
}

function packageMetrics(): Record<string, unknown> {
  const packageDirectory = path.join(root, 'dist-app')
  const installers = fs.existsSync(packageDirectory)
    ? fs.readdirSync(packageDirectory)
        .filter((name) => /^CodeZ Setup .*\.exe$/.test(name))
        .map((name) => ({
          name,
          bytes: fs.statSync(path.join(packageDirectory, name)).size,
          modifiedAt: fs.statSync(path.join(packageDirectory, name)).mtime.toISOString()
        }))
        .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
    : []
  return {
    installer: installers[0] ?? null,
    unpackedBytes: directoryBytes(path.join(packageDirectory, 'win-unpacked'))
  }
}

async function main(): Promise<void> {
  const [{ stdout: commit }, workspaceTree, search, syntheticFirstToken, ptyThroughput, electron] =
    await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }),
      measureWorkspaceTree(),
      measureSearch(),
      measureSyntheticFirstToken(),
      measurePtyThroughput(),
      measureElectronStartup()
    ])
  const baseline = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    commit: commit.trim(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    methodology: {
      startup: 'median of 3 isolated Electron userData launches; ready-to-show, did-finish-load and first animation frame; no screenshots',
      idleMemory: 'sum of Electron app.getAppMetrics().memory.workingSetSize after 2 seconds',
      workspaceTree: 'median of 5 WorkspaceService.getAllPaths runs on this repository',
      search: 'median of 5 bundled-rg searches for window.api in renderer TypeScript',
      firstToken: 'median of 7 in-memory OpenAI-compatible SSE parser runs; network excluded',
      pty: 'one MiB through the legacy node-pty adapter primitive',
      package: 'latest existing CodeZ installer and win-unpacked directory'
    },
    electron,
    package: packageMetrics(),
    workspaceTree,
    search,
    syntheticFirstToken,
    ptyThroughput
  }
  fs.mkdirSync(path.dirname(outputFile), { recursive: true })
  fs.writeFileSync(outputFile, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(baseline, null, 2))
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
