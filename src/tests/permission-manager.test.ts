import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import os from 'os'
import * as path from 'path'
import { PermissionManager } from '../main/services/PermissionManager'

const workspaceRoot = path.resolve('/tmp/codez-workspace')
const context = (mode: 'auto' | 'full-access') => ({ workspaceRoot, cwd: workspaceRoot, platform: process.platform, mode })

describe('PermissionManager', () => {
  const manager = new PermissionManager()

  it('allows reads and workspace writes in auto mode', async () => {
    expect((await manager.evaluateToolCall('Read', {}, context('auto'))).action).toBe('allow')
    expect((await manager.evaluateToolCall('Edit', { file_path: path.join(workspaceRoot, 'a.ts') }, context('auto'))).action).toBe('allow')
  })

  it('recognizes a restricted subagent launch as read-only orchestration', async () => {
    const decision = await manager.evaluateToolCall(
      'SubAgentRunner',
      { subagent_type: 'Explore', prompt: 'inspect permissions' },
      context('auto')
    )

    expect(decision).toMatchObject({
      action: 'allow',
      permission: 'read',
      ruleId: 'tool.subagent.restricted',
      normalizedPattern: 'SubAgentRunner:Explore'
    })
  })

  it.each([
    ['DelegateTasks', 'tool.delegation.execute'],
    ['PushNotification', 'tool.notification.send']
  ] as const)('recognizes %s as a known external effect', async (toolName, ruleId) => {
    const decision = await manager.evaluateToolCall(toolName, {}, context('auto'))

    expect(decision).toMatchObject({
      action: 'ask',
      permission: 'external_effect',
      ruleId
    })
    expect(decision.ruleId).not.toBe('unknown.tool')
  })

  it('keeps genuinely unregistered tools in the unknown fallback', async () => {
    const decision = await manager.evaluateToolCall('NotRegisteredTool', {}, context('auto'))

    expect(decision).toMatchObject({ permission: 'unknown', ruleId: 'unknown.tool' })
  })

  it('asks for network commands only in auto mode', async () => {
    expect((await manager.evaluateToolCall('Bash', { command: 'npm install react' }, context('auto'))).action).toBe('ask')
    expect((await manager.evaluateToolCall('Bash', { command: 'npm install react' }, context('full-access'))).action).toBe('allow')
  })

  it.each([
    'npm.cmd install react',
    'pnpm.cmd add react',
    '.\\mvnw.cmd dependency:go-offline',
    '.\\gradlew.bat test --refresh-dependencies'
  ])('recognizes network operations through Windows build-tool shims: %s', async (command) => {
    const decision = await manager.evaluateToolCall('PowerShell', { command }, context('auto'))

    expect(decision.action).toBe('ask')
    expect(decision.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ permission: 'network', action: 'ask' })
    ]))
  })

  it('allows compound PowerShell version queries as read-only commands', async () => {
    const decision = await manager.evaluateToolCall(
      'PowerShell',
      { command: 'node -v; npm -v; pnpm -v; yarn -v; cargo -v' },
      context('auto')
    )

    expect(decision.action).toBe('allow')
    expect(decision.riskLevel).toBe(0)
    expect(decision.critical).toBe(false)
  })

  it('fully analyzes git status with an option terminator and slash paths', async () => {
    const command = 'git status --short -- src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/error.rs src-tauri/src/database src-tauri/src/todo src-tauri/tests/database.rs src-tauri/src/lib.rs'
    const decision = await manager.evaluateToolCall('PowerShell', { command }, context('auto'))

    expect(decision).toMatchObject({
      action: 'allow',
      analysisStatus: 'parsed',
      riskLevel: 0
    })
    expect(decision.checks.some((check) => check.permission === 'shell_unparsed')).toBe(false)
  })

  it.each([
    'cargo fmt --manifest-path src-tauri/Cargo.toml -- --check; if (-not $?) { exit 1 }; cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings; if (-not $?) { exit 1 }; cargo test --manifest-path src-tauri/Cargo.toml',
    'cargo fmt --manifest-path src-tauri/Cargo.toml; if (-not $?) { exit 1 }; cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings; if (-not $?) { exit 1 }; cargo test --manifest-path src-tauri/Cargo.toml'
  ])('fully analyzes Cargo validation chains with PowerShell failure guards', async (command) => {
    const decision = await manager.evaluateToolCall('PowerShell', { command }, context('auto'))

    expect(decision.analysisStatus).toBe('parsed')
    expect(decision.checks.some((check) => check.permission === 'shell_unparsed')).toBe(false)
  })

  it('fully analyzes compact relative path lists in PowerShell cmdlets', async () => {
    const command = "Select-String -Path (Get-ChildItem -Path docs,.codez -Recurse -Include '*.md','*.json' -File -ErrorAction SilentlyContinue).FullName -Pattern 'runtime status changed' -Encoding UTF8 -Context 2,4"
    const decision = await manager.evaluateToolCall('PowerShell', { command }, context('auto'))

    expect(decision.analysisStatus).toBe('parsed')
    expect(decision.checks.some((check) => check.permission === 'shell_unparsed')).toBe(false)
  })

  it('fully analyzes Maven and Gradle Windows wrapper scripts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-java-wrappers-'))
    try {
      await writeFile(path.join(root, 'mvnw.cmd'), '@echo off\r\nmvn %*', 'utf8')
      await writeFile(path.join(root, 'gradlew.bat'), '@echo off\r\ngradle %*', 'utf8')
      const commands = [
        '.\\mvnw.cmd -pl :app -am verify -DskipTests=false --batch-mode',
        '.\\gradlew.bat clean test --no-daemon --stacktrace -Penv=ci -x integrationTest'
      ]

      for (const command of commands) {
        const decision = await manager.evaluateToolCall(
          'PowerShell',
          { command },
          { ...context('auto'), workspaceRoot: root, cwd: root }
        )
        expect(decision.analysisStatus).toBe('parsed')
        expect(decision.checks.some((check) => check.permission === 'shell_unparsed')).toBe(false)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('detects dangerous commands hidden in a repository-local package-manager shim', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-dangerous-shim-'))
    try {
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8')
      await writeFile(path.join(root, 'npm.cmd'), '@echo off\r\ndel /s /q C:\\Users\\*', 'utf8')
      const decision = await manager.evaluateToolCall(
        'PowerShell',
        { command: '.\\npm.cmd test' },
        { ...context('auto'), workspaceRoot: root, cwd: root }
      )

      expect(decision).toMatchObject({ action: 'ask', hardline: true, ruleId: 'critical.delete.system-root' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('detects dangerous commands hidden with cmd caret line continuations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-dangerous-continuation-shim-'))
    try {
      await writeFile(path.join(root, 'npm.cmd'), '@echo off\r\nde^\r\nl /s /q C:\\Users\\*', 'utf8')
      const decision = await manager.evaluateToolCall(
        'PowerShell',
        { command: '.\\npm.cmd test' },
        { ...context('auto'), workspaceRoot: root, cwd: root }
      )

      expect(decision).toMatchObject({ action: 'ask', hardline: true, ruleId: 'critical.delete.system-root' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('evaluates every compound operation independently', async () => {
    const decision = await manager.evaluateToolCall(
      'PowerShell',
      { command: 'git status; npm install react' },
      context('auto')
    )

    expect(decision.action).toBe('ask')
    expect(decision.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ permission: 'shell', pattern: 'git status', action: 'allow' }),
      expect.objectContaining({ permission: 'network', pattern: 'npm install react', action: 'ask' })
    ]))
  })

  it('allows normal unparsed commands in full-access mode', async () => {
    const decision = await manager.evaluateToolCall('PowerShell', { command: 'npm missing-script' }, context('full-access'))

    expect(decision.action).toBe('allow')
    expect(decision.analysisStatus).toBe('unparsed')
    expect(decision.hardline).toBe(false)
  })

  it('asks for npm version even when a version lifecycle script exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-npm-version-'))
    try {
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { version: 'echo lifecycle' } }), 'utf8')
      const decision = await manager.evaluateToolCall(
        'PowerShell',
        { command: 'npm version' },
        { ...context('auto'), workspaceRoot: root, cwd: root }
      )

      expect(decision.action).toBe('ask')
      expect(decision.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ permission: 'external_effect', pattern: 'npm version', action: 'ask' })
      ]))
      expect(decision.analysisStatus).toBe('parsed')
      expect(decision.hardline).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats npm publish as a known network operation', async () => {
    const decision = await manager.evaluateToolCall('PowerShell', { command: 'npm publish' }, context('auto'))

    expect(decision.action).toBe('ask')
    expect(decision.analysisStatus).toBe('parsed')
    expect(decision.checks).toEqual([
      expect.objectContaining({ permission: 'network', pattern: 'npm publish', action: 'ask' })
    ])
  })

  it('recursively scans nested package scripts for Hardline commands', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-nested-script-'))
    try {
      await writeFile(path.join(root, 'package.json'), JSON.stringify({
        scripts: {
          outer: 'npm run inner',
          inner: 'powershell -e YQ=='
        }
      }), 'utf8')
      const decision = await manager.evaluateToolCall(
        'PowerShell',
        { command: 'npm run outer' },
        { ...context('auto'), workspaceRoot: root, cwd: root }
      )

      expect(decision.hardline).toBe(true)
      expect(decision.ruleId).toBe('critical.hidden.encoded-command')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    'cmd /c "$env:ComSpec /c del C:/tmp/x & rem"',
    'cmd /c "${env:ComSpec} /c del C:/tmp/x & rem" -- src/a/b'
  ])('keeps dynamic shell-wrapper bodies out of the auto-allow path', async (command) => {
    const decision = await manager.evaluateToolCall('PowerShell', { command }, context('auto'))

    expect(decision).toMatchObject({
      action: 'ask',
      hardline: true,
      ruleId: 'critical.hidden.dynamic-command'
    })
  })

  it('keeps a package directory override while scanning nested scripts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-nested-prefix-'))
    try {
      const packageRoot = path.join(root, 'packages', 'app')
      await mkdir(packageRoot, { recursive: true })
      await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
        scripts: {
          outer: 'npm run inner',
          inner: 'powershell -e YQ=='
        }
      }), 'utf8')
      const decision = await manager.evaluateToolCall(
        'PowerShell',
        { command: 'npm --prefix packages/app run outer' },
        { ...context('auto'), workspaceRoot: root, cwd: root }
      )

      expect(decision.hardline).toBe(true)
      expect(decision.ruleId).toBe('critical.hidden.encoded-command')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['Bash', 'bash -c "npm install react"', undefined],
    ['PowerShell', 'powershell -Command "Invoke-WebRequest https://example.test"', undefined],
    ['run_command', 'cmd /c npm install react', 'cmd']
  ] as const)('includes normal checks from shell wrapper bodies: %s', async (toolName, command, shellKind) => {
    const decision = await manager.evaluateToolCall(
      toolName,
      { command },
      { ...context('auto'), shellKind }
    )

    expect(decision.action).toBe('ask')
    expect(decision.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ permission: 'network', action: 'ask' })
    ]))
  })

  it.each(['npm -V', 'npm -v unexpected', 'npm missing-script'])(
    'asks normally when package commands cannot be expanded: %s',
    async (command) => {
      const decision = await manager.evaluateToolCall('PowerShell', { command }, context('auto'))

      expect(decision.action).toBe('ask')
      expect(decision.critical).toBe(false)
      expect(decision.hardline).toBe(false)
      expect(decision.analysisStatus).toBe('unparsed')
      expect(decision.checks.some((check) => check.permission === 'shell_unparsed')).toBe(true)
    }
  )

  it('asks for L4 in both modes', async () => {
    expect((await manager.evaluateToolCall('Bash', { command: 'sudo rm -rf /var/lib/example' }, context('auto'))).riskLevel).toBe(4)
    expect((await manager.evaluateToolCall('Bash', { command: 'sudo rm -rf /var/lib/example' }, context('full-access'))).action).toBe('ask')
  })
})
