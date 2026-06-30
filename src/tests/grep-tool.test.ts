// src/tests/grep-tool.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { GrepTool } from '../main/tools/builtin/GrepTool'

let root: string

async function setup(): Promise<string> {
  root = path.join(os.tmpdir(), `codez-grep-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'const log = 1\nfunction foo() { return log + 1 }\n')
  await fs.writeFile(path.join(root, 'src', 'b.tsx'), 'export const Bar = () => null\n')
  await fs.writeFile(path.join(root, 'multi.txt'), 'start\nspan\nend\n')
  return root
}

describe('GrepTool', () => {
  beforeEach(async () => { await setup() })
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

  it('files_with_matches：返回命中路径', async () => {
    const tool = new GrepTool()
    const result = await tool.execute(JSON.stringify({ pattern: 'log', output_mode: 'files_with_matches' }), { workspaceRoot: root })
    const lines = result.split('\n').filter(Boolean)
    expect(lines.some((l) => l.replace(/\\/g, '/').endsWith('src/a.ts'))).toBe(true)
    expect(lines.some((l) => l.replace(/\\/g, '/').endsWith('src/b.tsx'))).toBe(false)
  })

  it('content + -n:true：返回带行号的匹配行', async () => {
    const tool = new GrepTool()
    const result = await tool.execute(JSON.stringify({ pattern: 'foo', output_mode: 'content', '-n': true }), { workspaceRoot: root })
    expect(result).toContain('foo')
    expect(result).toMatch(/\b2\b/) // 第二行
  })

  it('glob 过滤生效', async () => {
    const tool = new GrepTool()
    const result = await tool.execute(JSON.stringify({ pattern: '.', output_mode: 'files_with_matches', glob: '**/*.tsx' }), { workspaceRoot: root })
    const lines = result.split('\n').filter(Boolean)
    expect(lines.length).toBe(1)
    expect(lines[0].replace(/\\/g, '/').endsWith('src/b.tsx')).toBe(true)
  })

  it('-A/-B 上下文出现', async () => {
    const tool = new GrepTool()
    const result = await tool.execute(JSON.stringify({ pattern: 'span', output_mode: 'content', '-A': 1, '-B': 1 }), { workspaceRoot: root })
    expect(result).toContain('start')
    expect(result).toContain('span')
    expect(result).toContain('end')
  })

  it('head_limit 限制输出条数', async () => {
    const tool = new GrepTool()
    const result = await tool.execute(JSON.stringify({ pattern: '.', output_mode: 'files_with_matches', head_limit: 1 }), { workspaceRoot: root })
    const lines = result.split('\n').filter(Boolean)
    expect(lines.length).toBe(1)
  })

  it('ripgrep 不可用：返错（不回退纯 JS）', async () => {
    process.env.CODEZ_RG_PATH = path.join(root, 'no-such-rg')
    try {
      const tool = new GrepTool()
      const result = await tool.execute(JSON.stringify({ pattern: 'log' }), { workspaceRoot: root })
      expect(result.startsWith('Error:')).toBe(true)
      expect(result).toContain('ripgrep')
    } finally {
      delete process.env.CODEZ_RG_PATH
    }
  })

  it('缺 pattern：返错', async () => {
    const tool = new GrepTool()
    const result = await tool.execute(JSON.stringify({}), { workspaceRoot: root })
    expect(result.startsWith('Error:')).toBe(true)
  })
})
