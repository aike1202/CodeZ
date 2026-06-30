import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs/promises'
import { MemoryService } from '../main/services/MemoryService'

describe('MemoryService', () => {
  const testDir = path.join(__dirname, 'tmp_memory_test')
  const testWorkspace = path.join(testDir, 'workspace')

  beforeEach(async () => {
    await fs.mkdir(testWorkspace, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true })
  })

  it('getMemoryDir should return a stable path for the same workspace', () => {
    const dir1 = MemoryService.getMemoryDir(testWorkspace)
    const dir2 = MemoryService.getMemoryDir(testWorkspace)
    expect(dir1).toBe(dir2)
    expect(dir1).toContain('.codez')
    expect(dir1).toContain('memory')
  })

  it('different workspaces should get different memory dirs', () => {
    const dir1 = MemoryService.getMemoryDir(path.join(testDir, 'ws1'))
    const dir2 = MemoryService.getMemoryDir(path.join(testDir, 'ws2'))
    expect(dir1).not.toBe(dir2)
  })

  it('ensureInitialized should create directory and MEMORY.md', async () => {
    await MemoryService.ensureInitialized(testWorkspace)
    const memDir = MemoryService.getMemoryDir(testWorkspace)
    const indexPath = path.join(memDir, 'MEMORY.md')

    const dirExists = await fs.stat(memDir).then(s => s.isDirectory()).catch(() => false)
    expect(dirExists).toBe(true)

    const indexExists = await fs.stat(indexPath).then(s => s.isFile()).catch(() => false)
    expect(indexExists).toBe(true)
  })

  it('getIndex should return empty string for fresh memory', async () => {
    await MemoryService.ensureInitialized(testWorkspace)
    const index = await MemoryService.getIndex(testWorkspace)
    expect(index).toBe('')
  })

  it('appendToIndex should add entry line', async () => {
    await MemoryService.ensureInitialized(testWorkspace)
    await MemoryService.appendToIndex(testWorkspace, '- [Fix login](fix-login.md) — Login fix')

    const index = await MemoryService.getIndex(testWorkspace)
    expect(index).toContain('[Fix login](fix-login.md)')
    expect(index).toContain('Login fix')
  })

  it('ensureInitialized should be idempotent', async () => {
    await MemoryService.ensureInitialized(testWorkspace)
    await MemoryService.ensureInitialized(testWorkspace)
    // Should not throw
    const memDir = MemoryService.getMemoryDir(testWorkspace)
    const exists = await fs.stat(memDir).then(s => s.isDirectory()).catch(() => false)
    expect(exists).toBe(true)
  })
})
