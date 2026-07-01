# 调度系统设计文档（Monitor / Cron / ScheduleWakeup）

> 创建时间：2026-07-01
> 状态：approved
> 范围：src/main/services/SchedulerService.ts + 5 个 Tool + 前端通知展示

## 1. 目标

为 CodeZ Agent 添加 3 类调度能力：
- **Monitor**：实时监听命令输出，每行 stdout 作为事件推送
- **Cron**：定时触发（单次/重复），调度 prompt 队列
- **ScheduleWakeup**：Agent 自休眠延迟唤醒

## 2. 新增文件

```
src/main/services/
├── SchedulerService.ts           ← 调度引擎单例

src/main/tools/builtin/
├── MonitorTool.ts
├── CronCreateTool.ts
├── CronDeleteTool.ts
├── CronListTool.ts
├── ScheduleWakeupTool.ts

src/tests/
├── scheduler-service.test.ts
├── monitor-tool.test.ts
├── cron-tool.test.ts
```

## 3. 修改文件

```
src/main/tools/ToolManager.ts     ← 注册 5 个新工具
src/main/index.ts                 ← SchedulerService.init() / shutdown()
src/main/ipc/chat.handlers.ts     ← SCHEDULER IPC 注册（可选）
src/shared/ipc/channels.ts        ← 新增 IPC 通道常量
src/renderer/src/stores/chatStore.ts ← scheduledJobs 状态
```

## 4. SchedulerService 架构

### 单例接口

```ts
class SchedulerService {
  private static instance: SchedulerService

  static getInstance(): SchedulerService

  // 生命周期
  init(): Promise<void>           // 启动时恢复持久化的 Cron/Wakeup
  shutdown(): void                // 退出时清理所有 job + 持久化

  // Monitor
  startMonitor(config: MonitorConfig): string    // 返回 monitorId
  stopMonitor(monitorId: string): void
  listMonitors(): MonitorJob[]

  // Cron
  createCron(config: CronConfig): string         // 返回 jobId
  deleteCron(jobId: string): void
  listCrons(): CronJob[]

  // Wakeup
  scheduleWakeup(config: WakeupConfig): string   // 返回 wakeupId
  cancelWakeup(wakeupId: string): void

  // 事件回调
  onEvent: ((event: SchedulerEvent) => void) | null
}
```

### 内部实现

```
Monitor:
  child_process.spawn(command, shell: true)
  → 每行 stdout → this.onEvent({ type: 'monitor', ... })
  → 进程 exit → 自动清理 + 通知前端

Cron:
  解析 cron 表达式 → 计算 nextFireAt
  → setTimeout(nextFireAt - now)
  → 触发 → this.onEvent({ type: 'cron', ... })
  → recurring → 重新计算 nextFireAt，设置下一个 setTimeout

Wakeup:
  setTimeout(delaySeconds * 1000)
  → 触发 → this.onEvent({ type: 'wakeup', ... })
  → 自动清理

持久化：
  ~/.codez/scheduled_tasks.json
  {
    crons: [{ id, cron, prompt, recurring, durable, createdAt }],
    wakeups: [{ id, delayMs, prompt, reason, createdAt, wakeAt }]
  }
  Monitor 不持久化（进程级别）
```

## 5. MonitorTool

| 属性 | 值 |
|------|-----|
| name | `Monitor` |
| input | `{ command: string, description: string, persistent?: boolean, timeout_ms?: number }` |
| output | `{ ok: boolean, data: { monitorId: string, status: "started" } }` |

参数：
- `command`：shell 命令（必填）
- `description`：简短描述，显示在通知中（必填）
- `persistent`：默认 false。true=会话生命周期，不超时
- `timeout_ms`：默认 300000 (5min)，max 3600000 (1h)

## 6. CronCreateTool

| 属性 | 值 |
|------|-----|
| name | `CronCreate` |
| input | `{ cron: string, prompt: string, recurring?: boolean, durable?: boolean }` |
| output | `{ ok: boolean, data: { jobId: string, nextFireAt: string } }` |

参数：
- `cron`：5 字段标准 cron 表达式（必填）
- `prompt`：触发时的提示文本（必填）
- `recurring`：默认 true
- `durable`：默认 false。true=持久化跨会话

规则：
- 时区：用户本地
- 7 天自动过期（recurring + non-durable）
- 最小粒度：1 分钟
- 非 0/30 起点自动错峰

## 7. CronDeleteTool

| 属性 | 值 |
|------|-----|
| name | `CronDelete` |
| input | `{ id: string }` |
| output | `{ ok: boolean }` |

## 8. CronListTool

| 属性 | 值 |
|------|-----|
| name | `CronList` |
| input | `{}` |
| output | `{ ok: boolean, data: { jobs: Array<{ id, cron, prompt, recurring, nextFireAt }> } }` |

## 9. ScheduleWakeupTool

| 属性 | 值 |
|------|-----|
| name | `ScheduleWakeup` |
| input | `{ delaySeconds: number, prompt: string, reason: string }` |
| output | `{ ok: boolean, data: { wakeupId: string, wakeAt: string } }` |

参数：
- `delaySeconds`：clamp [60, 3600]（必填）
- `prompt`：唤醒时的提示文本（必填）
- `reason`：简短说明，显示给用户（必填）

调度策略：
- 60s–270s：prompt cache 内（不浪费 warm cache）
- 270s–1200s：短等待
- 1200s–1800s：长空闲（推荐默认）
- 禁止 300s 精确值（最差选择：cache 过期的临界点）

## 10. IPC 通道

```ts
SCHEDULER_EVENT: 'scheduler:event'     // main → renderer
// { type: 'monitor'|'cron'|'wakeup', id: string, data: string, description?: string }

SCHEDULER_STATE: 'scheduler:state'     // main → renderer
// { monitors: [...], crons: [...], wakeups: [...] }

SCHEDULER_CANCEL: 'scheduler:cancel'   // renderer → main
// { id: string }
```

## 11. 前端展示

### Monitor 事件 — 聊天流内

```
┌──────────────────────────────────────┐
│ 📡 errors in app.log                 │
│ ERROR: connection refused at port    │
│ 3000                                 │
└──────────────────────────────────────┘
```

### Cron — 聊天流内（触发时）

```
[system] Cron job "check CI" fired at 10:00.
Prompt: "check CI status"
```

### Wakeup — 聊天流底部

```
┌──────────────────────────────────────┐
│ ⏳ Agent paused — resuming at 10:20  │
│    Reason: deploy wait               │
│    [Cancel Wakeup]                   │
└──────────────────────────────────────┘
```

### 活跃调度指示 — TopBar

```
CodeZ  ⏱ 3 · 📡 2
```

## 12. System Prompt 补充

```
【SCHEDULING TOOLS】
- Monitor: Watch long-running processes (logs, servers, CI).
  Use for continuous event streams, not one-off checks.
- Cron: Schedule recurring or delayed prompts.
  Non-durable crons auto-expire after 7 days.
  Avoid :00 and :30 minute marks to prevent load spikes.
- ScheduleWakeup: Pause and resume yourself after a delay.
  Pick 60s-270s to keep prompt cache warm, or 1200s+ for long waits.
  Never pick 300s — it wastes the cache without benefit.
```

## 13. 持久化格式

`~/.codez/scheduled_tasks.json`：

```json
{
  "crons": [
    {
      "id": "cron_001",
      "cron": "*/5 * * * *",
      "prompt": "check CI status",
      "recurring": true,
      "durable": true,
      "createdAt": "2026-07-01T10:00:00Z",
      "lastFiredAt": null
    }
  ],
  "wakeups": [
    {
      "id": "wake_001",
      "delayMs": 1200000,
      "prompt": "继续部署",
      "reason": "wait for deploy",
      "createdAt": "2026-07-01T10:00:00Z",
      "wakeAt": "2026-07-01T10:20:00Z"
    }
  ]
}
```

## 14. 安全性

| 约束 | 实现 |
|------|------|
| Monitor 命令白名单 | 无（走同一套 PermissionManager 审批） |
| Cron recurrent 上限 | 7 天自动过期（非 durable） |
| Wakeup delay 范围 | clamp [60, 3600] |
| 子进程退出 | SchedulerService 统一清理，无僵尸进程 |
| 持久化文件大小 | 最多 100 条，超过则清理过期项 |

## 15. 不涉及的范围

- 不在前端显示 Cron 管理面板（CronList 工具即可）
- 不做秒级 cron
- 不做跨设备调度同步
- Monitor 不支持 WebSocket（仅 shell 命令），WebSocket 转 Monitor 后续通过 `ws:` scheme 扩展
