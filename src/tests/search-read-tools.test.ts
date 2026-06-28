import { describe, it, expect } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { SearchTool } from '../main/tools/builtin/SearchTool'
import { ReadFilesTool } from '../main/tools/builtin/ReadFilesTool'

async function setupWorkspace(): Promise<string> {
  const root = path.join(os.tmpdir(), `codez-search-read-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(path.join(root, 'src', 'main'), { recursive: true })
  await fs.mkdir(path.join(root, 'docs'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'main', 'AgentRunner.ts'), [
    'export class AgentRunner {',
    '  run() {',
    '    return "agent-loop"',
    '  }',
    '}',
    ''
  ].join('\n'))
  await fs.writeFile(path.join(root, 'src', 'main', 'UntrackedFeature.ts'), 'export const featureFlag = "untracked-search-target"\n')
  await fs.writeFile(path.join(root, 'docs', 'guide.md'), '# Guide\nSearchable documentation line\n')
  await fs.writeFile(path.join(root, 'long.txt'), Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join('\n'))
  return root
}

describe('SearchTool', () => {
  it('file search 应通过 filesystem 找到未跟踪文件并返回统一结构', async () => {
    const root = await setupWorkspace()
    try {
      const tool = new SearchTool()
      const result = await tool.execute(JSON.stringify({
        type: 'file',
        query: 'UntrackedFeature',
        maxResults: 10
      }), { workspaceRoot: root })

      const parsed = JSON.parse(result)
      expect(parsed.matches).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'file',
          path: 'src/main/UntrackedFeature.ts',
          preview: 'src/main/UntrackedFeature.ts'
        })
      ]))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('file search 拼写不完整时应返回 fuzzy 候选', async () => {
    const root = await setupWorkspace()
    try {
      const tool = new SearchTool()
      const result = await tool.execute(JSON.stringify({
        type: 'file',
        query: 'AgntRunnr',
        maxResults: 10
      }), { workspaceRoot: root })

      const parsed = JSON.parse(result)
      expect(parsed.matches.some((item: any) => item.kind === 'fuzzy' && item.path === 'src/main/AgentRunner.ts')).toBe(true)
      expect(parsed.suggestion).toContain('fuzzy')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('text search 应返回 kind/path/line/column/preview', async () => {
    const root = await setupWorkspace()
    try {
      const tool = new SearchTool()
      const result = await tool.execute(JSON.stringify({
        type: 'text',
        query: 'untracked-search-target',
        maxResults: 10
      }), { workspaceRoot: root })

      const parsed = JSON.parse(result)
      expect(parsed.matches).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'text',
          path: 'src/main/UntrackedFeature.ts',
          line: 1,
          preview: expect.stringContaining('untracked-search-target')
        })
      ]))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('ReadFilesTool', () => {
  it('应默认带行号并支持 contextAroundLine', async () => {
    const root = await setupWorkspace()
    try {
      const tool = new ReadFilesTool()
      const result = await tool.execute(JSON.stringify({
        filePaths: ['long.txt'],
        contextAroundLine: 10,
        contextLines: 2
      }), { workspaceRoot: root })

      const parsed = JSON.parse(result)
      const file = parsed.files[0]
      expect(file.startLine).toBe(8)
      expect(file.endLine).toBe(12)
      expect(file.content).toContain('8\tline-8')
      expect(file.content).toContain('10\tline-10')
      expect(file.includeLineNumbers).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('应遵守 maxTotalLines 并返回 omitted/budget 信息', async () => {
    const root = await setupWorkspace()
    try {
      const tool = new ReadFilesTool()
      const result = await tool.execute(JSON.stringify({
        filePaths: ['long.txt'],
        startLine: 1,
        endLine: 20,
        maxTotalLines: 5
      }), { workspaceRoot: root })

      const parsed = JSON.parse(result)
      const file = parsed.files[0]
      expect(file.returnedLines).toBe(5)
      expect(file.budgetExceeded).toBe(true)
      expect(file.omittedLines).toBeGreaterThan(0)
      expect(parsed.budget.budgetExceeded).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('应遵守 maxTotalBytes 并返回 truncated', async () => {
    const root = await setupWorkspace()
    try {
      const tool = new ReadFilesTool()
      const result = await tool.execute(JSON.stringify({
        filePaths: ['long.txt'],
        startLine: 1,
        endLine: 20,
        maxTotalBytes: 30
      }), { workspaceRoot: root })

      const parsed = JSON.parse(result)
      const file = parsed.files[0]
      expect(file.truncated).toBe(true)
      expect(file.omittedBytes).toBeGreaterThan(0)
      expect(parsed.budget.budgetExceeded).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
