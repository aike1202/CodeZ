# Tauri 资源与打包路径 spike

> 状态：Windows x64 通过，其他平台待验证
>
> 日期：2026-07-16

## 目的

验证 builtin skills、Rust parser grammar、随包 `rg`、Tauri resource target 和运行时 locator 的一致性。Electron 资源配置保持不变。

## 实现

- `src-tauri/tauri.conf.json`：将 builtin skills 映射到 `builtin-skills/`。
- `src-tauri/tauri.windows.conf.json`：将 Windows x64 `rg.exe` 映射到 `tools/rg.exe`。
- `codez-platform::ResourceLocator`：从 Tauri `resource_dir` 解析并验证固定路径。
- `scripts/tauri/analyze-resource-bundle.ts`：校验 bundle 输入、拒绝 symlink、运行 `rg --version` 并生成 SHA-256 清单。
- `docs/migration/generated/resource-bundle-inputs.json`：确定性资源输入报告。

运行：

```powershell
npm.cmd run analyze:tauri-resources
npm.cmd run build:tauri -- --debug --no-bundle
```

## Windows x64 结果

| 项目 | 结果 |
| --- | --- |
| builtin skills | 20 个文件，209,619 bytes；3 个入口 `SKILL.md` 均存在。 |
| symlink | 0；分析器遇到 symlink 会拒绝。 |
| ripgrep | `ripgrep 15.0.0 (rev 3a612f88b8)`，5,429,760 bytes，可执行。 |
| 安装目标 | `$RESOURCE/builtin-skills/` 与 `$RESOURCE/tools/rg.exe`。 |
| Rust parser assets | 0 个 WASM；固定 grammar 编译进 binary。 |
| Tauri renderer | 生产构建通过。 |
| Tauri Rust host | debug 编译/链接通过，生成 `target/debug/codez-desktop.exe`。 |
| capability | 保持 `core:default`，未授予前端通用 Shell/文件访问。 |

## 路径边界

`ResourceLocator` 不从 cwd、环境变量或前端参数拼接生产路径。它只从 Tauri `resource_dir` 派生：

```text
$RESOURCE/
  builtin-skills/
    find-skills/SKILL.md
    rule-creator/SKILL.md
    skill-creator/SKILL.md
  tools/
    rg.exe
```

开发期资源缺失只产生 setup 诊断；具体工具启动必须调用 `validate_required()`，不能静默回退到系统 PATH 中不受控的 `rg`。

## 限制

- 当前只配置和验证 Windows x64 optional package。
- `--no-bundle` 证明配置合并、资源输入、renderer 与 host 编译，不证明真实 NSIS 安装升级；Phase 9 必须安装候选包并再次验证资源目录。
- macOS/Linux 需要相应平台配置、可执行权限和签名/notarization 验证。
- builtin skill 内的 Python 脚本只是静态资源；Python runtime 可用性由调用该脚本的工具能力单独处理。
- 资源清单包含文件 hash，不包含用户数据或运行日志。
