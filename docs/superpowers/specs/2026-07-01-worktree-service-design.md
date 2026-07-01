# Worktree 隔离设计文档

> 创建时间：2026-07-01
> 状态：approved
> 范围：src/main/services/WorktreeService.ts（底层封装，暂不暴露为 Tool 或前端）

## 1. 目标

封装 git worktree 命令，为未来 Workflow/Swarm 阶段提供文件系统级隔离能力。本阶段只实现 `WorktreeService` 底层服务，不创建 Tool，不添加前端。

## 2. 新增文件

```
src/main/services/WorktreeService.ts
src/tests/worktree-service.test.ts
```

## 3. 不修改的文件

- AgentRunner.ts
- ToolManager.ts
- chat.handlers.ts
- 任何 IPC handler
- 任何 renderer 文件

## 4. 接口

```ts
class WorktreeService {
  static create(workspaceRoot: string, name: string): { path: string; branch: string }
  static remove(workspaceRoot: string, name: string, force?: boolean): void
  static list(workspaceRoot: string): Array<{ path: string; branch: string; head: string }>
  static exists(workspaceRoot: string, name: string): boolean
}
```

## 5. 路径约定

```
<workspaceRoot>/.claude/worktrees/<name>/
```

分支命名规则：`worktree/<name>`

## 6. 实现细节

### create

```
git worktree add <workspaceRoot>/.claude/worktrees/<name> -b worktree/<name>
```

- 分支已存在：改为 `git worktree add <path> worktree/<name>`
- 返回 `{ path: "/abs/path/.claude/worktrees/<name>", branch: "worktree/<name>" }`
- 超时 30s

### remove

```
git worktree remove <path>
```

- `force=true` → 追加 `--force`
- 删除 worktree 目录后：`git branch -D worktree/<name>`（失败不抛错）
- 超时 30s

### list

```
git worktree list --porcelain
```

- 解析 porcelain 格式输出（`worktree /path`, `HEAD <hash>`, `branch refs/heads/<name>` 块）
- 失败→返回空数组

### exists

基于 `list()` 结果检查 name 匹配。

## 7. 安全性

| 约束 | 实现 |
|------|------|
| 路径沙箱 | name 只允许 `[a-zA-Z0-9_-]+`，拒绝 `/`、`..`、`\`、空格 |
| 目录约束 | worktree 目录硬编码为 `.claude/worktrees/` 下，不可自定义 |
| 非 git 仓库 | 所有方法先检查 `git rev-parse --git-dir`，非仓库抛错 |
| 超时 | 所有 `execSync` 30s 超时 |

## 8. name sanitize

```ts
private static sanitize(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64)
  if (!safe || safe === '.' || safe === '..') {
    throw new Error(`Invalid worktree name: "${name}"`)
  }
  return safe
}
```

## 9. 测试

```ts
describe('WorktreeService', () => {
  it('create should return path and branch')
  it('create should sanitize name (reject ../) ')
  it('create should reject empty name')
  it('list should include created worktree')
  it('exists should return true for created worktree')
  it('exists should return false for non-existent name')
  it('remove should delete worktree directory')
  it('remove with force should also delete branch')
  it('create with existing branch name should not fail')
  it('create on non-git directory should throw')
})
```

测试策略：因为 `git worktree` 需要真实 git 仓库，测试直接使用 CodeZ 自身的 git 仓库（`path.resolve(__dirname, '..')`）。每个测试在 `afterEach` 中清理创建的 worktree。

## 10. 后续计划

- P2 阶段：基于 WorktreeService 实现 `EnterWorktreeTool` / `ExitWorktreeTool`，暴露给 Agent
- P3 阶段：Workflow/Swarm 通过 WorktreeService 为子 Agent 创建隔离工作区
