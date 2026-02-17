# PRD-03: The Sentinel — 实时异常检测

## 现状

完全未实现。当前代码中没有任何异常检测逻辑。

已有的数据基础：
- 每次 model.usage event 都入库（timestamp, session_key, model, cost_usd, tokens）
- per-event 触发点存在（handler 在每次 event 后执行 checkBudget）

缺失的数据基础（依赖 PRD-01 Ledger 补全）：
- `context_tokens` — context spike 检测的前提
- `tool_name` + `tool_params_hash` — loop detection 的前提

## 目标功能

4 个检测器，全部基于简单统计阈值，无 ML 依赖：

### 3a. Loop Detector
同一 session 内，同一 tool 在 N 次调用窗口内被调用 ≥ M 次，且 tool_params_hash 相同或高度重复。

触发条件（可配置）：
```jsonc
{
  "sentinel": {
    "loopDetection": {
      "windowSize": 10,        // 最近 N 次调用
      "repeatThreshold": 5,    // 同 tool+hash 出现 ≥ M 次
      "action": "warn"         // warn | pause
    }
  }
}
```

### 3b. Context Growth Spike
同一 session 内，连续两次调用之间 context_tokens 增长超过阈值。

触发条件：
```jsonc
{
  "sentinel": {
    "contextSpike": {
      "growthPercent": 150,    // context 增长 ≥ 150%
      "absoluteMin": 50000,    // 且绝对增量 ≥ 50K tokens（避免小数值误报）
      "action": "warn"
    }
  }
}
```

### 3c. Cost Velocity Anomaly
滚动 5 分钟内的 $/min 超过 24 小时均值的 N 倍。

触发条件：
```jsonc
{
  "sentinel": {
    "costVelocity": {
      "windowMinutes": 5,
      "multiplier": 3,         // 5min 速率 ≥ 3× 24h 均值
      "action": "warn"
    }
  }
}
```

### 3d. Heartbeat Drift
同一 cron job 的 cost-per-run 随时间递增，表明 session context 在累积。

触发条件：
```jsonc
{
  "sentinel": {
    "heartbeatDrift": {
      "lookbackRuns": 10,      // 对比最近 10 次 run
      "driftPercent": 50,      // 最新 run 成本 ≥ 前 N 次均值的 150%
      "action": "warn"
    }
  }
}
```

### 告警通道

告警通过 OpenClaw 的 channel 系统发送（复用用户已配置的 WhatsApp/Telegram/Discord）：
```jsonc
{
  "sentinel": {
    "alertChannel": "telegram:main"  // 或 "discord:alerts", "webhook:https://..."
  }
}
```

如果 OpenClaw plugin API 不支持直接发送 channel 消息，fallback 方案：
- 通过 `ctx.logger.warn()` 输出到 OpenClaw 日志
- 通过 `before_agent_start` hook 注入 prependContext 警告

## 实现计划

### 前置：确认依赖
- PRD-01 Ledger 的 context_tokens, tool_name, tool_params_hash 列必须先完成
- 确认 OpenClaw plugin API 是否提供 `ctx.sendMessage(channel, text)` 或类似能力

### 1. Sentinel 模块 — `src/sentinel.ts`（新文件）

```typescript
interface SentinelConfig {
  loopDetection?: LoopConfig;
  contextSpike?: ContextSpikeConfig;
  costVelocity?: CostVelocityConfig;
  heartbeatDrift?: HeartbeatDriftConfig;
  alertChannel?: string;
}

interface SentinelAlert {
  detector: string;       // "loop" | "contextSpike" | "costVelocity" | "heartbeatDrift"
  severity: "warn" | "critical";
  sessionKey: string;
  message: string;
  data: Record<string, any>;
}
```

核心函数：
- `checkAfterEvent(record: UsageRecord, config: SentinelConfig): SentinelAlert[]`
  - 每次 insertUsage 后调用
  - 依次运行启用的检测器
  - 返回触发的告警列表（可能为空）

### 2. 各检测器实现

**Loop Detector:**
- 查询 `getRecentToolCalls(sessionKey, windowSize)` （PRD-01 新增的 query）
- 按 tool_name + tool_params_hash 分组计数
- 任一组 count ≥ repeatThreshold → 触发

**Context Spike:**
- 查询当前 session 最近 2 条记录的 context_tokens
- 计算增长率和绝对增量
- 同时满足 growthPercent 和 absoluteMin → 触发

**Cost Velocity:**
- 查询最近 windowMinutes 内的 SUM(cost_usd) → 计算 $/min
- 查询最近 24h 的 SUM(cost_usd) / 1440 → 24h 均值 $/min
- 比值 ≥ multiplier → 触发

**Heartbeat Drift:**
- 仅对 source="cron" 的记录触发
- 查询 getCronRunHistory(jobId, lookbackRuns)
- 最新 run 的 totalCost vs 前 N-1 次均值
- 比值 ≥ 1 + driftPercent/100 → 触发

### 3. 告警发送 — `src/alert.ts`（新文件）

```typescript
function sendAlert(alert: SentinelAlert, channel: string, ctx: any): void
```

- 优先使用 `ctx.sendChannelMessage?.(channel, formatAlert(alert))`
- Fallback: `ctx.logger.warn(formatAlert(alert))`
- 去重：同一 detector + sessionKey 在 5 分钟内不重复告警（内存 Map + TTL）

### 4. 集成到 index.ts

- handler 中 insertUsage 之后调用 `checkAfterEvent(record, sentinelConfig)`
- 遍历返回的 alerts → sendAlert
- 如果 alert.action === "pause" → 设置 session-level block flag（复用 Guard 的 block 机制）

### 5. configSchema 更新

- `openclaw.plugin.json` 增加 `sentinel` 对象及其子字段

## 测试计划

### Loop Detector
1. 同 session 内 5 次相同 tool+hash → 触发 alert
2. 同 session 内 4 次相同 tool+hash → 不触发
3. 不同 session 的相同 tool 调用 → 不互相影响
4. 相同 tool 但不同 hash → 不触发（参数不同，非 loop）

### Context Spike
5. context 从 50K → 150K（+200%, +100K）→ 触发
6. context 从 1K → 3K（+200%, +2K）→ 不触发（absoluteMin 未达标）
7. context 从 100K → 120K（+20%, +20K）→ 不触发（growthPercent 未达标）

### Cost Velocity
8. 5min 内花费 $1（$/min=0.2），24h 均值 $/min=0.01 → 比值 20× → 触发
9. 5min 内花费 $0.01，24h 均值 $/min=0.01 → 比值 1× → 不触发
10. 24h 无数据（冷启动）→ 不触发（避免除零）

### Heartbeat Drift
11. 最近 10 次 cron run 成本 [0.1, 0.1, 0.1, ..., 0.1, 0.2] → 最新 200% of 均值 → 触发
12. 成本稳定 [0.1, 0.1, 0.1, ...] → 不触发
13. 非 cron source 的记录 → 跳过检测

### 告警
14. 告警去重：同一 detector+session 5 分钟内只发一次
15. alertChannel 配置为空 → fallback 到 logger.warn
16. action="pause" → 后续 before_tool_call 返回 block

### 集成
17. 完整流程：emit events → sentinel 检测 → alert 发送 → hook 响应

## 前置依赖

- PRD-01 Ledger 补全（context_tokens, tool_name, tool_params_hash）
- OpenClaw plugin API 的 channel 消息发送能力（可 fallback）

## 验收标准

- [ ] 4 个检测器独立可配置、可禁用
- [ ] 每个检测器的阈值均可通过 configSchema 配置
- [ ] 告警去重机制生效
- [ ] 告警通过 channel 或 logger fallback 发送
- [ ] 不影响 event 处理性能（检测逻辑应在 <10ms 内完成）
- [ ] 所有现有测试继续通过
- [ ] 新增测试覆盖上述 17 个场景
