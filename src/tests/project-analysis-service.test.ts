import { describe, it, expect } from 'vitest'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as os from 'os'
import { ProjectAnalysisService } from '../main/services/ProjectAnalysisService'

async function setupProject(): Promise<string> {
  const root = path.join(os.tmpdir(), `myagent-project-analysis-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(path.join(root, 'src', 'main'), { recursive: true })
  await fs.mkdir(path.join(root, 'src', 'preload'), { recursive: true })
  await fs.mkdir(path.join(root, 'src', 'renderer', 'src'), { recursive: true })
  await fs.mkdir(path.join(root, 'src', 'shared', 'ipc'), { recursive: true })

  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture',
    main: './out/main/index.js',
    scripts: {
      dev: 'electron-vite dev',
      build: 'electron-vite build',
      test: 'vitest run',
    },
    dependencies: {
      react: '^18.0.0',
      electron: '^31.0.0',
    },
    devDependencies: {
      vite: '^5.0.0',
      'electron-vite': '^2.0.0',
      typescript: '^5.0.0',
    },
  }, null, 2))
  await fs.writeFile(path.join(root, 'package-lock.json'), '{}')
  await fs.writeFile(path.join(root, 'README.md'), '# Fixture')
  await fs.writeFile(path.join(root, 'src', 'main', 'index.ts'), 'export function boot() {}')
  await fs.writeFile(path.join(root, 'src', 'preload', 'index.ts'), 'contextBridge.exposeInMainWorld("api", {})')
  await fs.writeFile(path.join(root, 'src', 'renderer', 'src', 'App.tsx'), 'export const App = () => null')
  await fs.writeFile(path.join(root, 'src', 'shared', 'ipc', 'channels.ts'), 'export const IPC_CHANNELS = {}')
  return root
}

describe('ProjectAnalysisService', () => {
  it('getProjectSnapshot 应缓存并在 package.json 变化后失效', async () => {
    const root = await setupProject()
    try {
      const service = new ProjectAnalysisService(root)
      const first = await service.getProjectSnapshot({ forceRefresh: true })
      expect(first.fromCache).toBe(false)
      expect(first.projectType).toBe('electron-react')
      expect(first.packageManager).toBe('npm')
      expect(first.scripts.build).toBe('electron-vite build')
      expect(first.recommendedFiles).toContain('package.json')
      expect(first.recommendedFiles).toContain('src/main/index.ts')

      const second = await service.getProjectSnapshot()
      expect(second.fromCache).toBe(true)

      const packagePath = path.join(root, 'package.json')
      const current = JSON.parse(await fs.readFile(packagePath, 'utf-8'))
      current.scripts.typecheck = 'tsc --noEmit'
      await fs.writeFile(packagePath, JSON.stringify(current, null, 2))

      const third = await service.getProjectSnapshot()
      expect(third.fromCache).toBe(false)
      expect(third.scripts.typecheck).toBe('tsc --noEmit')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('readManyFiles 应该批量读取文件并处理过大截断', async () => {
    const root = await setupProject()
    try {
      const service = new ProjectAnalysisService(root)
      const result = await service.readManyFiles([
        'package.json',
        'README.md',
        'not-exist.txt'
      ])

      expect(result.files.length).toBe(3)
      const pkg = result.files.find(f => f.path === 'package.json')
      expect(pkg?.content).toContain('"name": "fixture"')
      expect(pkg?.truncated).toBe(false)

      const readme = result.files.find(f => f.path === 'README.md')
      expect(readme?.content).toContain('# Fixture')

      const notExist = result.files.find(f => f.path === 'not-exist.txt')
      expect(notExist?.error).toBeDefined()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('searchCode 应该搜索代码并返回带上下文的匹配项', async () => {
    const root = await setupProject()
    try {
      const service = new ProjectAnalysisService(root)
      const result = await service.searchCode({
        query: 'exposeInMainWorld',
        dirPath: '.'
      })

      expect(result.matches.length).toBeGreaterThan(0)
      const match = result.matches.find(m => m.path === 'src/preload/index.ts')
      expect(match).toBeDefined()
      expect(match?.text).toContain('exposeInMainWorld')
      expect(match?.line).toBe(1)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('getSymbolMap 应该提取类、函数等符号索引', async () => {
    const root = await setupProject()
    try {
      const service = new ProjectAnalysisService(root)
      const result = await service.getSymbolMap({
        dirPath: '.'
      })

      expect(result.symbols.length).toBeGreaterThan(0)
      const boot = result.symbols.find(s => s.name === 'boot')
      expect(boot).toBeDefined()
      expect(boot?.kind).toBe('function')
      expect(boot?.path).toBe('src/main/index.ts')

      const app = result.symbols.find(s => s.name === 'App')
      expect(app).toBeDefined()
      expect(app?.kind).toBe('const')
      expect(app?.path).toBe('src/renderer/src/App.tsx')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
