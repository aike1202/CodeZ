import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { WorktreeService } from '../main/services/WorktreeService'

/**
 * WorktreeService 测试。
 *
 * git worktree 需要真实 git 仓库，因此在临时目录初始化一个隔离仓库，
 * 避免污染 CodeZ 自身的工作区。每个测试在 afterEach 清理其创建的 worktree。
 */
describe('WorktreeService', () => {
  let repoDir: string
  const created: string[] = []

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codez-wt-'))
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' })
    git(['init'])
    git(['config', 'user.email', 'test@codez.dev'])
    git(['config', 'user.name', 'codez-test'])
    git(['config', 'commit.gpgsign', 'false'])
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# temp repo\n')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
  })

  afterEach(() => {
    for (const name of created) {
      try {
        WorktreeService.remove(repoDir, name, true)
      } catch {
        // ignore
      }
    }
    created.length = 0
  })

  afterAll(() => {
    try {
      fs.rmSync(repoDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  const track = (name: string) => {
    created.push(name)
    return name
  }

  it('create should return path and branch', () => {
    const info = WorktreeService.create(repoDir, track('feat-a'))
    expect(info.branch).toBe('codez/wt/feat-a')
    expect(info.path).toContain(path.join('.codez', 'worktrees', 'feat-a'))
    expect(fs.existsSync(info.path)).toBe(true)
  })

  it('create should sanitize name (reject ../ traversal)', () => {
    const info = WorktreeService.create(repoDir, track('../evil'))
    // '../evil' → sanitized to '--evil', stays inside .codez/worktrees
    expect(info.path).toContain(path.join('.codez', 'worktrees'))
    expect(info.path).not.toContain('..')
    // remove uses same sanitize; track sanitized name for cleanup
    created[created.length - 1] = '--evil'
  })

  it('create should reject empty name', () => {
    // Only a zero-length input sanitizes to empty; other chars map to '-'.
    expect(() => WorktreeService.create(repoDir, '')).toThrow(/Invalid worktree name/)
  })

  it('list should include created worktree', () => {
    const info = WorktreeService.create(repoDir, track('feat-list'))
    const all = WorktreeService.list(repoDir)
    const found = all.some(wt => path.resolve(wt.path) === path.resolve(info.path))
    expect(found).toBe(true)
  })

  it('exists should return true for created worktree', () => {
    WorktreeService.create(repoDir, track('feat-exists'))
    expect(WorktreeService.exists(repoDir, 'feat-exists')).toBe(true)
  })

  it('exists should return false for non-existent name', () => {
    expect(WorktreeService.exists(repoDir, 'no-such-worktree')).toBe(false)
  })

  it('remove should delete worktree directory', () => {
    const info = WorktreeService.create(repoDir, 'feat-remove')
    expect(fs.existsSync(info.path)).toBe(true)
    WorktreeService.remove(repoDir, 'feat-remove', true)
    expect(fs.existsSync(info.path)).toBe(false)
  })

  it('remove with force should also delete branch', () => {
    WorktreeService.create(repoDir, 'feat-branch')
    WorktreeService.remove(repoDir, 'feat-branch', true)
    // branch should be gone
    let branchExists = true
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/codez/wt/feat-branch'], {
        cwd: repoDir,
        stdio: 'pipe',
      })
    } catch {
      branchExists = false
    }
    expect(branchExists).toBe(false)
  })

  it('create with existing branch name should not fail', () => {
    const name = track('feat-reuse')
    const first = WorktreeService.create(repoDir, name)
    expect(fs.existsSync(first.path)).toBe(true)
    // remove worktree but keep branch
    WorktreeService.remove(repoDir, name, true)
    // recreate branch manually
    execFileSync('git', ['branch', 'codez/wt/feat-reuse'], { cwd: repoDir, stdio: 'pipe' })
    // create again — should reuse existing branch, not throw
    const second = WorktreeService.create(repoDir, name)
    expect(fs.existsSync(second.path)).toBe(true)
  })

  it('create on non-git directory should throw', () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'codez-nongit-'))
    try {
      expect(() => WorktreeService.create(nonGit, 'x')).toThrow(/Not a git repository/)
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true })
    }
  })
})
