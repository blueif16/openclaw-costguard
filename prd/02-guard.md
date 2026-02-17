# PRD-02: The Guard — 多层级预算执行

## 现状

已完成：
- `BudgetConfig`: dailyLimitUsd, monthlyLimitUsd, warnThreshold(0.8), action("warn"|"block")
- `checkBudget(config)` → 返回 ok/warning/exceeded，daily 优先于 monthly 检查
- `before_tool_call` hook：exceeded 时返回 `{ block: true, blockReason }`
- `before_agent_start` hook：warning/exceeded 时注入 prependContext
- 配置来源：`openclaw.plugin.json` configSchema 的 4 个顶层字段

## 缺失项

| 缺失 | 价值 | 难度 |
|------|------|------|
| Per-agent 限额 | 不同 agent 不同预算上限 | 中（配置结构 + 查询过滤） |
| Per-cron-job 限额 | 防止单个 cron 失控 | 中 |
| Rolling window（周/自定义） | 灵活的预算周期 | 低 |
| Throttle 降级 | 超阈值自动切换便宜模型 | 高（依赖 core hook API） |
| Pause（暂停 session） | 完全停止失控 session | 高（依赖 core API） |

## 目标功能

### 2a. 多粒度限额

配置结构升级：
```jsonc
{
  "dailyLimitUsd": 10,
  "monthlyLimitUsd": 200,
  "warnThreshold": 0.8,
  "budgetAction": "block",
  // 新增：per-scope 覆盖
  "scopes": {
    "agent:work": { "dailyLimitUsd": 5 },
    "agent:home": { "dailyLimitUsd": 2 },
    "cron:daily-digest": { "dailyLimitUsd": 1, "monthlyLimitUsd": 20 },
    "cron:*": { "dailyLimitUsd": 3 }  // 通配符：所有 cron job 的默认限额
  }
}
```

匹配优先级：精确 scope → 通配符 scope → 全局限额

### 2b. Rolling window

新增 `weeklyLimitUsd` 配置项。内部实现：`getCostSince(now - 7d)`，复用现有 query。

### 2c. 三级响应

| 级别 | 触发条件 | 行为 |
|------|---------|------|
| warn | spend ≥ limit × warnThreshold | prependContext 注入警告 |
| throttle | spend ≥ limit × throttleThreshold | 改写 model 字段为 fallback model |
| block | spend ≥ limit | 拒绝调用 |

Throttle 配置：
```jsonc
{
  "throttleThreshold": 0.9,
  "throttleFallbackModel": "anthropic/claude-haiku-4"
}
```

## 实现计划

### Phase 1: 多粒度限额（无 core 依赖）

1. **配置解析** — `budget.ts`
   - 新增 `ScopeConfig` 接口和 `scopes: Record<string, Partial<BudgetConfig>>` 字段
   - 新增 `resolveScope(sessionKey, jobId, config)` → 返回合并后的有效限额
   - 匹配逻辑：从 sessionKey/jobId 提取 scope key → 精确匹配 → 通配符 → 全局

2. **查询过滤** — `db.ts`
   - 新增 `getCostSinceForScope(sinceMs, scopeFilter)` — WHERE 条件按 agent_id 或 job_id 过滤
   - 复用现有索引 idx_usage_session 和 idx_usage_job

3. **checkBudget 升级** — `budget.ts`
   - `checkBudget(config, sessionKey?, jobId?)` — 可选参数，传入时走 scope 逻辑
   - 新增 weekly 检查（`getCostSince(now - 7d)`）
   - 检查顺序：daily → weekly → monthly

4. **Hook 集成** — `index.ts`
   - `before_tool_call` handler 从 event context 提取 sessionKey → 传入 checkBudget
   - `before_agent_start` 同理

5. **configSchema 更新** — `openclaw.plugin.json`
   - 增加 `weeklyLimitUsd`, `scopes` 字段定义

### Phase 2: Throttle（需确认 core API）

6. **确认 hook 能力** — 调研 `before_tool_call` hook 的返回值是否支持 `{ rewriteModel: "..." }`
   - 如果支持：在 budget.ts 新增 throttle level，hook 返回 rewriteModel
   - 如果不支持：向 OpenClaw core 提 PR，或通过 diagnostic context 注入 model override hint

7. **Throttle 逻辑** — `budget.ts`
   - 新增 `throttleThreshold` 和 `throttleFallbackModel` 配置
   - checkBudget 返回新 level: `"throttle"`
   - hook 返回 `{ rewriteModel: config.throttleFallbackModel }`

### Phase 3: Pause（需 core API）

8. **Session pause** — 需要 OpenClaw 提供 `ctx.pauseSession()` 或类似 API
   - 当前 block 只能拒绝单次调用，无法暂停整个 session
   - 作为 fallback：连续 block 等效于 pause（每次调用都被拒绝）

## 测试计划

### Phase 1 测试
1. **Scope 解析**：精确 scope 匹配 > 通配符 > 全局 fallback
2. **Per-agent 限额**：agent:work 花费 $4（限额 $5）→ ok；花费 $6 → exceeded
3. **Per-cron 限额**：cron:daily-digest 花费 $0.8（限额 $1）→ warning；花费 $1.1 → exceeded
4. **通配符 scope**：未配置精确 scope 的 cron job → 命中 `cron:*` 限额
5. **Weekly 限额**：7天内累计超限 → exceeded
6. **Scope 隔离**：agent:work 超限不影响 agent:home 的判定
7. **getCostSinceForScope**：验证 WHERE 过滤正确，不同 scope 的数据互不干扰

### Phase 2 测试
8. **Throttle 触发**：spend 达到 90% → checkBudget 返回 throttle level
9. **Throttle hook 返回值**：验证 before_tool_call 返回 `{ rewriteModel }` 格式
10. **Throttle → Block 升级**：spend 从 90% 升到 100% → 从 throttle 切换到 block

### 集成测试
11. **完整流程**：emit events → scope 限额触发 → hook 正确响应（warn/throttle/block）
12. **配置热更新**：修改 pluginConfig → 新限额立即生效（无需重启）

## 前置依赖

- Phase 1：无外部依赖，可立即实现
- Phase 2：需确认 OpenClaw hook API 是否支持 rewriteModel 返回值
- Phase 3：需 OpenClaw core 提供 session pause API

## 验收标准

- [ ] per-agent 和 per-cron-job 限额独立生效
- [ ] 通配符 scope 作为 fallback 正确匹配
- [ ] weekly rolling window 正确计算
- [ ] 所有现有测试继续通过
- [ ] Phase 1 新增测试覆盖场景 1-7
