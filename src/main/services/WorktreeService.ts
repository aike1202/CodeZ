import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

/**
 * git worktree 封装服务。
 *
 * 为并行 Worker 提供文件系统级隔离：每个 Worker 在独立 worktree 内改文件，
 * 波末统一 merge 回主工作区。
 *
 * 路径约定：<workspaceRoot>/.codez/worktrees/<name>/
 * 分支约定：codez/wt/<name>
 *
 * 所有 git 命令 30s 超时；非 git 仓库抛错；name 严格 sanitize 防路径穿越。
 */
export class WorktreeService {
  private static readonly GIT_TIMEOUT_MS = 30_000
  private static readonly BRANCH_PREFIX = 'codez/wt/'
  private static readonly WORKTREE_SUBDIR = path.join('.codez', 'worktrees')

  /**
   * 校验并规范化 worktree 名称。
   * 仅允许 [a-zA-Z0-9_-]，其余字符替换为 '-'，截断到 64 字符。
   */
  private static sanitize(name: string): string {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64)
    if (!safe || safe === '.' || safe === '..') {
      throw new Error(`Invalid worktree name: "${name}"`)
    }
    return safe
  }

  /** 确认目标目录是 git 仓库，否则抛错。 */
  private static assertGitRepo(workspaceRoot: string): void {
    try {
      execFileSync('git', ['rev-parse', '--git-dir'], {
        cwd: workspaceRoot,
        timeout: this.GIT_TIMEOUT_MS,
        stdio: 'pipe',
      })
    } catch {
      throw new Error(`Not a git repository: ${workspaceRoot}`)
    }
  }

  private static git(workspaceRoot: string, args: string[]): string {
    return execFileSync('git', args, {
      cwd: workspaceRoot,
      timeout: this.GIT_TIMEOUT_MS,
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim()
  }

  private static branchName(name: string): string {
    return `${this.BRANCH_PREFIX}${name}`
  }

  private static worktreePath(workspaceRoot: string, name: string): string {
    return path.join(path.resolve(workspaceRoot), this.WORKTREE_SUBDIR, name)
  }

  /**
   * 创建 worktree。若同名分支已存在，复用该分支而非新建。
   * @returns worktree 绝对路径与分支名
   */
  static create(workspaceRoot: string, name: string): { path: string; branch: string } {
    this.assertGitRepo(workspaceRoot)
    const safe = this.sanitize(name)
    const branch = this.branchName(safe)
    const wtPath = this.worktreePath(workspaceRoot, safe)

    // 确保父目录存在
    fs.mkdirSync(path.dirname(wtPath), { recursive: true })

    // 判断分支是否已存在
    let branchExists = false
    try {
      this.git(workspaceRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
      branchExists = true
    } catch {
      branchExists = false
    }

    if (branchExists) {
      this.git(workspaceRoot, ['worktree', 'add', wtPath, branch])
    } else {
      this.git(workspaceRoot, ['worktree', 'add', wtPath, '-b', branch])
    }

    return { path: wtPath, branch }
  }

  /**
   * 移除 worktree 目录并删除对应分支（删分支失败不抛错）。
   */
  static remove(workspaceRoot: string, name: string, force?: boolean): void {
    this.assertGitRepo(workspaceRoot)
    const safe = this.sanitize(name)
    const branch = this.branchName(safe)
    const wtPath = this.worktreePath(workspaceRoot, safe)

    const removeArgs = ['worktree', 'remove', wtPath]
    if (force) removeArgs.push('--force')
    this.git(workspaceRoot, removeArgs)

    // 删除分支 —— 失败（如分支被 check out 或不存在）不影响主流程
    try {
      this.git(workspaceRoot, ['branch', '-D', branch])
    } catch {
      // ignore
    }
  }

  /**
   * 列出所有 worktree。
   */
  static list(workspaceRoot: string): Array<{ path: string; branch: string; head: string }> {
    try {
      this.assertGitRepo(workspaceRoot)
    } catch {
      return []
    }

    let raw: string
    try {
      raw = this.git(workspaceRoot, ['worktree', 'list', '--porcelain'])
    } catch {
      return []
    }

    const result: Array<{ path: string; branch: string; head: string }> = []
    // porcelain 以空行分隔每个 worktree 块
    const blocks = raw.split(/\n\s*\n/)
    for (const block of blocks) {
      const lines = block.split('\n')
      let wtPath = ''
      let head = ''
      let branch = ''
      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          wtPath = line.slice('worktree '.length).trim()
        } else if (line.startsWith('HEAD ')) {
          head = line.slice('HEAD '.length).trim()
        } else if (line.startsWith('branch ')) {
          branch = line.slice('branch '.length).trim().replace('refs/heads/', '')
        }
      }
      if (wtPath) result.push({ path: wtPath, branch, head })
    }
    return result
  }

  /**
   * 判断指定 name 的 worktree 是否已存在。
   */
  static exists(workspaceRoot: string, name: string): boolean {
    const safe = this.sanitize(name)
    const wtPath = path.resolve(this.worktreePath(workspaceRoot, safe))
    return this.list(workspaceRoot).some(wt => path.resolve(wt.path) === wtPath)
  }
}
