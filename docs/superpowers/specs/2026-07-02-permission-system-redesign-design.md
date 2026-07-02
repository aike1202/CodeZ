# Permission System Redesign

## Goal
重构 Agent 的权限控制系统（PermissionManager），解决当前基于简单字符串前缀匹配带来的命令逃逸和目录越界漏洞。同时，将不同语言栈的命令划分为 4 个危险等级，使其与 `ask`、`auto-approve-safe` 和 `full-access` 三种权限模式完美适配，并在 UI 层打通模式切换。

## Background & Security Flaws
目前代码存在以下安全漏洞与架构缺失：
1. **Shell 命令注入**：`getCommandRisk` 仅依靠 `startsWith` 检查前缀。如 `npm test && rm -rf /` 会被识别为安全命令自动放行。
2. **目录越界漏洞**：检查文件写入时，使用 `targetPath.startsWith(workspaceRoot)`。如果工作区为 `/myproject`，目标为 `/myproject_backup/file` 也会被错误放行。
3. **缺少 UI 控制**：`AgentRunner.ts` 中硬编码了 `auto-approve-safe`，目前用户无法在界面上真正切换到 `ask` 或 `full-access`。
4. **规则细粒度不足**：`ask` 模式会拦截所有命令（包括 `git status`），导致过多的无意义弹窗；同时没有基于目录的文件级白名单机制。

## Architecture & Design

### 1. 语法级拦截 (Shell Syntax Guard)
引入专门的正则表达式或语法检查器，在任何模式、任何风险评估之前，强制拦截以下危险语法组合（强制降级为最高危 `Level 3`）：
- **命令拼接符**：`&&`, `||`, `;`
- **管道与重定向**：`|`, `>`, `>>`, `<`
- **子Shell执行**：`$(...)`, `` `...` ``

### 2. 四级命令危险度 (Command Risk Levels)

| Level | 描述 | 典型命令 (支持多种技术栈) | 防御匹配规则 |
| :--- | :--- | :--- | :--- |
| **Level 0 (Safe)** | 纯只读命令，无副作用 | `git status`, `git log`, `ls`, `mvn -v`, `node -v` | 严格精确匹配或安全短前缀 (拒绝 `-delete`, `--exec`) |
| **Level 1 (Write)** | 修改工作区内容的常规开发流 | `npm run build`, `mvn compile`, `git commit`, `mkdir` | 前缀匹配 |
| **Level 2 (Network)** | 请求外部网络或安装全局依赖 | `npm install`, `mvn install`, `curl`, `wget`, `git push` | 前缀匹配 |
| **Level 3 (Destruct)** | 具有破坏性、越权或系统级操作 | `rm`, `chown`, `sudo`, `git reset --hard`，以及包含危险语法的命令 | 前缀匹配或命中语法拦截器 |

### 3. 三种权限模式矩阵 (Permission Matrix)

| 触发工具 / 动作 | 🛡️ `ask` (严格模式) | ⚖️ `auto-approve-safe` (平衡模式) | 🔓 `full-access` (完全信任) |
| :--- | :--- | :--- | :--- |
| **只读工具** (`Read`, `list_files`) | ✅ 自动放行 | ✅ 自动放行 | ✅ 自动放行 |
| **🟢 Level 0 命令** (如 `git status`) | ✅ 自动放行 | ✅ 自动放行 | ✅ 自动放行 |
| **🟡 Level 1 命令** (如 `mvn compile`) | ⚠️ 拦截询问 | ✅ 自动放行 | ✅ 自动放行 |
| **🟠 Level 2 命令** (如 `npm install`) | ⚠️ 拦截询问 | ⚠️ 拦截询问 | ✅ 自动放行 |
| **🔴 Level 3 命令** (含拼接符 / `rm`) | ⚠️ 拦截询问 | ⚠️ 拦截询问 | ✅ 自动放行 |
| **工作区内文件修改** (`Edit`/`Write`) | ⚠️ 拦截询问 | ✅ 自动放行 | ✅ 自动放行 |
| **工作区外文件修改** | ❌ 强行拒绝 | ❌ 强行拒绝 | ✅ 自动放行 |

*(如果命中 `PermissionRuleStore` 白名单，则在拦截时直接放行。)*

### 4. 目录越界修复
所有针对 `Edit` 和 `Write` 的边界检测，必须改用：
```typescript
const relativePath = path.relative(workspaceRoot, targetPath);
if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    // 越界，阻止操作
}
```

### 5. UI 与配置连通
1. 在 `src/renderer/src/components/SettingsPanel.tsx` 或类似全局设置面板中增加 `权限模式 (Workspace Mode)` 的 Select 下拉框。
2. 将选中的 Mode 保存到配置。
3. `AgentRunner.ts` (Line 513) 在调用 `PermissionManager.getInstance().checkToolPermission()` 时，动态传入配置中的 `workspaceMode`，而非缺省值。

## Spec Self-Review Checklist
- [x] Placeholder scan: No missing requirements or vague definitions.
- [x] Internal consistency: The level matrix matches the user intent where `ask` mode lets safe commands pass.
- [x] Scope check: Focused solely on fixing and extending the permission verification logic and linking its UI toggle.
- [x] Ambiguity check: The distinction between level 1 and 2 is clear.

## Next Steps
1. Wait for User Approval on this Spec.
2. Invoke `writing-plans` to generate the detailed implementation plan.
