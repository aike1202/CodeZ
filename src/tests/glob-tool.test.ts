// src/tests/glob-tool.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { GlobTool } from '../main/tools/builtin/GlobTool'

let root: string

async function setup(): Promise<string> {
  root = path.join(os.tmpdir(), `codez-glob-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
  await fs.writeFile(path.join(root, 'src', 'b.ts'), 'export const b = 2\n')
  await fs.writeFile(path.join(root, 'README.md'), '# readme\n')
  return root
}

describe('GlobTool', () => {
  beforeEach(async () => { await setup() })
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

  it('pattern **/*.ts 命中 TS 文件', async () => {
    const tool = new GlobTool()
    const result = await tool.execute(JSON.stringify({ pattern: '**/*.ts' }), { workspaceRoot: root })
    const lines = result.split('\n').filter(Boolean)
    expect(lines).toEqual(expect.arrayContaining([
      path.join('src', 'a.ts').replace(/\\/g, '/'),
      path.join('src', 'b.ts').replace(/\\/g, '/')
    ]))
    expect(lines.some((l) => l.endsWith('README.md'))).toBe(false)
  })

  it('path 指定子目录：仅该子树匹配', async () => {
    const tool = new GlobTool()
    const result = await tool.execute(JSON.stringify({ pattern: '**/*.ts', path: 'src' }), { workspaceRoot: root })
    const lines = result.split('\n').filter(Boolean)
    expect(lines.length).toBe(2)
  })

  it('缺 pattern：返错', async () => {
    const tool = new GlobTool()
    const result = await tool.execute(JSON.stringify({}), { workspaceRoot: root })
    expect(result.startsWith('Error:')).toBe(true)
  })

  it('ripgrep 不可用时回退 fast-glob 返回一致结果', async () => {
    process.env.CODEZ_RG_PATH = path.join(root, 'no-such-rg-binary')
    try {
      const tool = new GlobTool()
      const result = await tool.execute(JSON.stringify({ pattern: '**/*.ts' }), { workspaceRoot: root })
      const lines = result.split('\n').filter(Boolean)
      expect(lines.length).toBe(2)
    } finally {
      delete process.env.CODEZ_RG_PATH
    }
  })

  it('默认限制为 1000 条并报告实际匹配总数', async () => {
    const matches = Array.from({ length: 1500 }, (_, index) =>
      `bulk/file-${String(index).padStart(4, '0')}.ts`
    )
    const tool = new GlobTool()
    vi.spyOn(tool as any, 'listWithRipgrep').mockResolvedValue(matches)
    vi.spyOn(tool as any, 'listWithFastGlob').mockResolvedValue(matches)

    const result = await tool.execute(
      JSON.stringify({ pattern: 'bulk/**/*.ts' }),
      { workspaceRoot: root }
    )
    expect(result.split('\n').filter((line) => line.endsWith('.ts'))).toHaveLength(1000)
    expect(result).toContain('showing 1000 of 1500')
    expect(result).toContain('narrower pattern or path')
  })

  it('支持 head_limit 进一步限制结果数量', async () => {
    const result = await new GlobTool().execute(
      JSON.stringify({ pattern: '**/*.ts', head_limit: 1 }),
      { workspaceRoot: root }
    )
    expect(result.split('\n').filter((line) => line.endsWith('.ts'))).toHaveLength(1)
    expect(result).toContain('showing 1 of 2')
  })
})
