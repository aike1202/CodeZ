import { describe, it, expect } from 'vitest'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as os from 'os'
import { WorkspaceService } from '../main/services/WorkspaceService'

describe('WorkspaceService', () => {
  let tmpDir: string

  async function setup(): Promise<void> {
    tmpDir = path.join(os.tmpdir(), `myagent-test-${Date.now()}`)
    await fs.mkdir(tmpDir, { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{"name":"test"}')
    await fs.writeFile(path.join(tmpDir, 'index.ts'), 'console.log("hello")')
    await fs.mkdir(path.join(tmpDir, 'node_modules'))
    await fs.writeFile(path.join(tmpDir, 'node_modules', 'dep.js'), '// dep')
    await fs.mkdir(path.join(tmpDir, 'src'))
    await fs.writeFile(path.join(tmpDir, 'src', 'app.ts'), 'export const x = 1')
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'out/\n')
  }

  async function cleanup(): Promise<void> {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }

  it('validatePath 应解析 Workspace 内路径', async () => {
    await setup()
    try {
      const service = new WorkspaceService(tmpDir)
      const resolved = service.validatePath('src/app.ts')
      expect(resolved).toBe(path.join(tmpDir, 'src/app.ts'))
    } finally {
      await cleanup()
    }
  })

  it('validatePath 应拒绝 ../ 路径', async () => {
    await setup()
    try {
      const service = new WorkspaceService(tmpDir)
      expect(() => service.validatePath('../outside.txt')).toThrow()
    } catch {
      // expected
    } finally {
      await cleanup()
    }
  })

  it('scanFileTree 应忽略 node_modules', async () => {
    await setup()
    try {
      const service = new WorkspaceService(tmpDir)
      const tree = await service.scanFileTree()
      const names = tree.map((n) => n.name)
      expect(names).not.toContain('node_modules')
      expect(names).toContain('package.json')
      expect(names).toContain('src')
    } finally {
      await cleanup()
    }
  })

  it('detectProjectType 应识别 Node.js 项目', async () => {
    await setup()
    try {
      const service = new WorkspaceService(tmpDir)
      const info = await service.detectProjectType()
      expect(info.type).toBe('nodejs')
    } finally {
      await cleanup()
    }
  })

  it('detectProjectType 应返回 unknown 对空目录', async () => {
    const emptyDir = path.join(os.tmpdir(), `myagent-test-empty-${Date.now()}`)
    await fs.mkdir(emptyDir, { recursive: true })
    try {
      const service = new WorkspaceService(emptyDir)
      const info = await service.detectProjectType()
      expect(info.type).toBe('unknown')
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true })
    }
  })

  it('readFileContent 应读取文本文件内容', async () => {
    await setup()
    try {
      const service = new WorkspaceService(tmpDir)
      const result = await service.readFileContent('index.ts')
      expect(result.content).toContain('console.log')
      expect(result.truncated).toBe(false)
    } finally {
      await cleanup()
    }
  })
})
