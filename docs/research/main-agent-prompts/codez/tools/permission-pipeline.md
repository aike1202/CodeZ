# 工具权限与执行管线

## 唯一生命周期顺序

源码注释定义：

```text
validate, classify, authorize, schedule, execute, process, then journal
```

展开后：

```text
1. canonicalize workspace root
2. resolve canonical tool name/alias
3. require tool present in immutable catalog
4. require tool present in current exposure plan
5. check descriptor.is_enabled(environment)
6. JSON Schema validate raw arguments
7. handler.normalize_input(validated input)
8. plan_effects and resource_keys concurrently
9. bind authorization to tool/input/effects/workspace/session/role
10. PermissionService decides allow/deny and returns metadata
11. issue short-lived signed authorization receipt, default TTL 30s
12. Scheduler forms waves from concurrency/resource keys
13. before execute, recompute binding and validate receipt/expiry
14. construct ToolContext with authorized effects and trusted services
15. execute with interrupt/timeout behavior
16. attach effects and process large result
17. append terminal journal records
```

## 为什么 normalize 必须在授权前

当前 PowerShell 修正正好位于 schema validation 后、effect planning 前。这样去除旧 UTF-8 setup 后，分类器、权限规则、receipt 和真实业务命令一致。若在授权后才去除，receipt binding 会与执行参数不一致；若在执行后才处理，权限仍会被 `shellunparsed` 卡住。

## Effect 类型

工具会产生结构化 effects，例如：

```text
ReadFile(path, scope)
WriteFile(path, mode)
SpawnAgent(role, read_only, isolation)
MutateTaskState(session)
ReadMemory(path)
ControlExecution(id, action)
Internal(target)
Unknown(target)
```

PermissionService 分析 effect plan，而不是只按工具名授权。无法解析的 descriptor 默认产生 Unknown，不静默放行。

## TOCTOU 防护

- 路径在 planning 和 execute 两阶段验证。
- authorization receipt 绑定 canonical args/effects/workspace/session/role。
- 执行前重新计算 binding。
- 文件 mutation 检查 Read fingerprint 和 current delivery。
- Agent role allowlist 在 exposure 层隐藏工具，并在调用层再次返回 `TOOL_NOT_EXPOSED`。

## 调度

```text
Safe             可与无资源冲突的调用并行
ResourceLocked   按 resource key 分波
Exclusive        shell 等独占执行
```

结果按原 tool call position 排序回传，执行 wave 可并发，但模型看到的 tool result 协议顺序稳定。

## Journal

`tool-execution.jsonl`/journal 保存 received、permission_decided、queued/started、wave、duration、terminal status、error code、permission rule/mode 等，不保存凭据。权限审计另写 permission audit。
