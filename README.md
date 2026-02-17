# CostGuard — OpenClaw Cost Tracking Plugin

Real-time cost tracking, multi-granularity budget enforcement, anomaly detection, and usage attribution for OpenClaw gateway.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   OpenClaw Gateway                       │
│                                                         │
│  ┌──────────────┐   model call    ┌──────────────────┐  │
│  │ reply-*.js   │ ──────────────► │ emitDiagnostic   │  │
│  │ pi-embed.js  │   completes     │ Event()          │  │
│  │ loader.js    │                 │                  │  │
│  │ extAPI.js    │                 │ ┌──────────────┐ │  │
│  └──────────────┘                 │ │ listeners$N  │ │  │
│        4 bundles, each with       │ │ (local Set)  │ │  │
│        own copy of diagnostic     │ └──────┬───────┘ │  │
│        event system               │        │         │  │
│                                   │ ┌──────▼───────┐ │  │
│                                   │ │ globalThis   │ │  │
│  ┌─────────────────────┐         │ │ [Symbol.for( │ │  │
│  │   CostGuard Plugin  │◄────────│ │  "openclaw.  │ │  │
│  │                     │  bridge │ │  diagnostic  │ │  │
│  │  handler(evt) ──┐   │         │ │  Bridge")]   │ │  │
│  │                 │   │         │ └──────────────┘ │  │
│  │  ┌──────────────▼┐  │         └──────────────────┘  │
│  │  │ estimateCost() │  │                               │
│  │  │ (LiteLLM JSON) │  │                               │
│  │  └───────┬────────┘  │                               │
│  │          │            │                               │
│  │  ┌───────▼────────┐  │                               │
│  │  │ SQLite DB      │  │                               │
│  │  │ costguard.db   │  │                               │
│  │  └───────┬────────┘  │                               │
│  │          │            │                               │
│  │  ┌───────▼────────┐  │                               │
│  │  │ /cost command  │  │                               │
│  │  │ budget checks  │  │                               │
│  │  │ sentinel       │  │                               │
│  │  └────────────────┘  │                               │
│  └─────────────────────┘                                │
└─────────────────────────────────────────────────────────┘
```

## The Bridge Problem

OpenClaw bundles `diagnostic-events.ts` into **4 separate JS files**, each with its own module-scoped `listeners` Set. The plugin-sdk has a 5th copy. `onDiagnosticEvent` from plugin-sdk subscribes to the wrong Set — events never arrive.

**Solution:** Patch `isDiagnosticsEnabled()` and `emitDiagnosticEvent()` in all 4 bundles to push events through `globalThis[Symbol.for("openclaw.diagnosticBridge")]` — a shared Set that the plugin subscribes to.

Patched files (in `openclaw/dist/`):
- `loader-Ds3or8QX.js`
- `reply-DptDUVRg.js`
- `pi-embedded-CWm3BvmA.js`
- `extensionAPI.js`

> ⚠️ `npm update openclaw` will overwrite these patches. Re-apply after upgrades.

## Pricing

On startup, fetches [LiteLLM model_prices_and_context_window.json](https://github.com/BerriAI/litellm) (~2100 models). Cached locally at `~/.openclaw/costguard-pricing.json` (24h TTL). Falls back to cache if fetch fails.

Model name matching: exact match → bare name after stripping path prefixes → Dice coefficient fuzzy match (≥0.6 threshold).

## Attribution

Session key 自动解析来源类型：

| Pattern | Source |
|---|---|
| `agent:main:main` | user |
| `agent:main:cron:<jobId>[:run:<runId>]` | cron |
| `agent:main:subagent:<uuid>` | subagent |
| `agent:main:acp:...` | acp |
| `agent:main:heartbeat` | heartbeat (best-effort) |

## Commands

| Command | Description |
|---|---|
| `/cost` | 今日费用汇总 |
| `/cost today\|24h\|week\|month` | 指定时段费用 |
| `/cost session:<key>` | 逐 turn session 分析（含 context/tool/Δ Context 列、BLOAT 标注、诊断建议） |
| `/cost session:<key> --compact` | 仅显示 BLOAT 异常 turn |
| `/cost cron:<jobId> [--last N]` | Cron job 历次运行对比（含 peak ctx 和 growth 倍数） |
| `/cost top [N]` | 按费用排序的 top sessions |

## Budget Enforcement

### 基础配置

在 `openclaw.json` 的 `plugins.costguard` 中配置：

```jsonc
{
  "dailyLimitUsd": 10,
  "weeklyLimitUsd": 50,
  "monthlyLimitUsd": 200,
  "warnThreshold": 0.8,
  "budgetAction": "warn"
}
```

检查顺序：daily → weekly → monthly，命中即停。

### 多粒度 Scope 限额

Per-agent / per-cron-job 独立预算，支持通配符：

```jsonc
{
  "scopes": {
    "agent:work": { "dailyLimitUsd": 5 },
    "agent:home": { "dailyLimitUsd": 2 },
    "cron:daily-digest": { "dailyLimitUsd": 1, "monthlyLimitUsd": 20 },
    "cron:*": { "dailyLimitUsd": 3 }
  }
}
```

匹配优先级：精确 scope → 通配符 scope（`cron:*` / `agent:*`）→ 全局限额。

### 三级响应

| 级别 | 触发条件 | 行为 |
|---|---|---|
| warn | spend ≥ limit × `warnThreshold` | `before_agent_start` 注入警告 context |
| throttle | spend ≥ limit × `throttleThreshold` | `before_tool_call` 返回 `{ rewriteModel }` 切换到便宜模型 |
| block | spend ≥ limit | `before_tool_call` 返回 `{ block: true }` 拒绝调用 |

Throttle 配置：

```jsonc
{
  "throttleThreshold": 0.9,
  "throttleFallbackModel": "anthropic/claude-haiku-4"
}
```

## Sentinel — 异常检测

每次 `model.usage` 事件后自动运行 4 个检测器，告警自动去重（同 detector+session 5 分钟内不重复）。告警发送到配置的 channel，无 channel 时 fallback 到 logger。

### 检测器

| 检测器 | 作用 | 关键配置 |
|---|---|---|
| loopDetection | 检测同一 tool+params 重复调用 | `windowSize`(10), `repeatThreshold`(5) |
| contextSpike | 检测 context tokens 突增 | `growthPercent`(150), `absoluteMin`(50000) |
| costVelocity | 检测短时费用飙升（对比 24h 均值） | `windowMinutes`(5), `multiplier`(3) |
| heartbeatDrift | 检测 cron job 单次费用偏离历史均值 | `lookbackRuns`(10), `driftPercent`(50) |

每个检测器的 `action` 可设为 `"warn"` 或 `"pause"`。`pause` 会将该 session 加入阻断名单。

### Sentinel 配置示例

```jsonc
{
  "sentinel": {
    "alertChannel": "#ops-alerts",
    "loopDetection": { "windowSize": 10, "repeatThreshold": 5, "action": "pause" },
    "contextSpike": { "growthPercent": 150, "absoluteMin": 50000, "action": "warn" },
    "costVelocity": { "windowMinutes": 5, "multiplier": 3, "action": "warn" },
    "heartbeatDrift": { "lookbackRuns": 10, "driftPercent": 50, "action": "warn" }
  }
}
```

## Session Report 诊断

`/cost session:<key>` 输出包含：

- 逐 turn 表格：序号、时间、费用、Context tokens、Model、Tool name、Δ Context 变化百分比
- BLOAT 自动标注：单 turn context 增长 ≥100% 且绝对增量 ≥50K tokens 时标记 `⚠ BLOAT`
- 4 种诊断建议：
  - 大文件 tool output 导致 context 膨胀（Write/bash/readFile）
  - Web search 结果撑大 context
  - 连续 3+ turn context 持续增长 → 建议 `/compact`
  - Session 接近 context limit（>200K tokens）
- `--compact` 模式：仅显示 BLOAT turn，快速定位问题

## DB Schema

SQLite 存储于 `~/.openclaw/costguard.db`，WAL 模式。

核心字段：`timestamp`, `session_key`, `agent_id`, `source`, `job_id`, `model`, `provider`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `duration_ms`, `context_tokens`, `tool_name`, `tool_params_hash`

旧库自动迁移：启动时检测缺失列（`context_tokens`, `tool_name`, `tool_params_hash`），通过 `ALTER TABLE` 补齐。

## Files

| File | Role |
|---|---|
| `src/index.ts` | Plugin entry, service registration, bridge subscription, hook 集成 |
| `src/pricing.ts` | LiteLLM fetch, cache, fuzzy match, cost calculation |
| `src/db.ts` | SQLite schema, auto-migration, insert, query helpers |
| `src/attribution.ts` | Session key → source type (user/cron/subagent/acp) |
| `src/budget.ts` | 多粒度 scope 解析, weekly window, 三级响应 (warn/throttle/block) |
| `src/formatter.ts` | `/cost` 报表格式化, session autopsy, cron report, diagnostics |
| `src/sentinel.ts` | 4 检测器, 告警去重, channel/logger fallback |
