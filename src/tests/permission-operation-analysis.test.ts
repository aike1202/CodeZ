import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { NestedCommandExpander } from '../main/services/permission/NestedCommandExpander'
import { PathImpactAnalyzer } from '../main/services/permission/PathImpactAnalyzer'

describe('permission operation analysis', () => {
  it.each([
    ['npm', '-v'],
    ['pnpm', '--version'],
    ['yarn', '-v'],
    ['bun', '-version']
  ])('does not expand %s %s as a package script', async (executable, versionArg) => {
    const result = await new NestedCommandExpander().expandCommand('powershell', [executable, versionArg], process.cwd(), process.cwd())

    expect(result).toEqual({ command: null, shell: null, snapshots: [] })
  })

  it('recognizes Windows package-manager shims when expanding scripts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-op-shim-'))
    try {
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8')
      const result = await new NestedCommandExpander().expandCommand('powershell', ['npm.cmd', 'test'], root, root)

      expect(result.command).toBe('vitest run')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prefers a repository-local package-manager shim over package.json expansion', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-local-shim-'))
    try {
      const shimPath = path.join(root, 'npm.cmd')
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8')
      await writeFile(shimPath, '@echo off\r\ndel /s /q C:\\Users\\*', 'utf8')
      const result = await new NestedCommandExpander().expandCommand('powershell', ['.\\npm.cmd', 'test'], root, root)

      expect(result.command).toContain('del /s /q')
      expect(result.snapshots[0].path).toBe(shimPath)
      expect(result.kind).toBe('script')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['mvnw', 'gradlew'])('expands and snapshots extensionless Java wrapper scripts: %s', async (wrapper) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-java-wrapper-'))
    try {
      const wrapperPath = path.join(root, wrapper)
      await writeFile(wrapperPath, '#!/bin/sh\nexec java -version', 'utf8')
      const result = await new NestedCommandExpander().expandCommand('bash', [`./${wrapper}`, 'test'], root, root)

      expect(result).toMatchObject({ command: '#!/bin/sh\nexec java -version', shell: 'bash', kind: 'script' })
      expect(result.snapshots[0].path).toBe(wrapperPath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['npm', 'version'],
    ['npm', 'publish'],
    ['pnpm', 'publish'],
    ['yarn', 'version']
  ])('does not treat known package-manager builtins as scripts: %s %s', async (...argv) => {
    const result = await new NestedCommandExpander().expandCommand('powershell', argv, process.cwd(), process.cwd())

    expect(result).toEqual({ command: null, shell: null, snapshots: [] })
  })

  it.each([
    ['npm', '-V'],
    ['npm', '-v', 'unexpected'],
    ['npm', 'missing-script']
  ])('keeps non-exact package commands opaque: %s', async (...argv) => {
    const result = await new NestedCommandExpander().expandCommand('powershell', argv, process.cwd(), process.cwd())

    expect(result.opaqueReason).toBe('unknown-script')
  })

  it('expands package scripts and records their hash', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-op-'))
    try {
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8')
      const result = await new NestedCommandExpander().expandCommand('bash', ['npm', 'test'], root, root)
      expect(result.command).toBe('vitest run')
      expect(result.snapshots[0].path).toBe(path.join(root, 'package.json'))
      expect(result.snapshots[0].sha256).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a local script cycle as unparsed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-script-cycle-'))
    try {
      const scriptPath = path.join(root, 'loop.sh')
      await writeFile(scriptPath, './loop.sh', 'utf8')
      const result = await new NestedCommandExpander().expandCommand(
        'bash',
        ['./loop.sh'],
        root,
        root,
        1,
        new Set([scriptPath])
      )

      expect(result.opaqueReason).toBe('nested-cycle')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['npm', '--prefix', 'packages/app', 'run', 'test'],
    ['pnpm', '-C', 'packages/app', 'test'],
    ['pnpm', '--dir', 'packages/app', 'run', 'test'],
    ['yarn', '--cwd', 'packages/app', 'test'],
    ['bun', '--cwd', 'packages/app', 'run', 'test']
  ])('expands package scripts after directory options: %s', async (...argv) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-package-option-'))
    try {
      const packageRoot = path.join(root, 'packages', 'app')
      await mkdir(packageRoot, { recursive: true })
      await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8')

      const result = await new NestedCommandExpander().expandCommand('bash', argv, root, root)

      expect(result.command).toBe('vitest run')
      expect(result.snapshots[0].path).toBe(path.join(packageRoot, 'package.json'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats a symlink escape as external', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-root-'))
    const outside = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-outside-'))
    try {
      await mkdir(path.join(root, 'links'))
      await symlink(outside, path.join(root, 'links', 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
      const result = await new PathImpactAnalyzer().analyze(path.join(root, 'links', 'outside', 'x.txt'), root)
      expect(result.insideWorkspace).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('treats CodeZ permission configuration as sensitive outside the workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-config-root-'))
    try {
      const target = path.join(os.homedir(), 'AppData', 'Roaming', 'CodeZ', 'permission-rules.json')
      const result = await new PathImpactAnalyzer().analyze(target, root)

      expect(result.sensitive).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
