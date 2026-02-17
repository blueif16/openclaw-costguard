# PRD-01: The Ledger — 成本取证级账本

## 现状

已完成：
- SQLite append-only `usage` 表，13列（id, timestamp, session_key, agent_id, source, job_id, model, provider, input/output/cache_read/cache_write tokens, cost_usd, duration_ms）
- 5个索引（timestamp, source, model, session_key, job_id），WAL模式
- globalThis bridge 订阅 `model.usage` diagnostic events，in-process 消费
- LiteLLM 定价获取 + 24h 本地缓存 + Dice coefficient 模糊匹配
- 完整的 query helpers：getCostSince, getCostByModel, getCostBySource, getCostBySession, getSessionTurns, getCronRunHistory, getDailyTotals
- insertUsage 从 event 中提取 usage.input, usage.output, usage.cacheRead, usage.cacheWrite

## 缺失项

| 缺失 | 影响范围 | 难度 |
|------|---------|------|
| `context_tokens` 列 | Sentinel 的 context spike 检测、Autopsy 的 bloat 标注 | 低（schema + event 解析） |
| `tool_name` 列 | Sentinel 的 loop detection、Autopsy 的 per-turn tool 显示 | 低（schema + event 解析） |
| `tool_params_hash` 列 | Sentinel 的 identical-params loop 检测 | 低 |

## 目标功能

Ledger 从"记录花了多少钱"升级为"记录每次调用的完整上下文快照"，使下游 Sentinel 和 Autopsy 能做 context 膨胀诊断和 loop 检测。

新增列定义：
```sql
context_tokens INTEGER DEFAULT 0,   -- 本次调用时 session 的 context window 占用
tool_name TEXT DEFAULT '',           -- 本次调用触发的 tool（如 readMessages, Write, bash）
tool_params_hash TEXT DEFAULT ''     -- tool 参数的 SHA-256 前 16 位，用于 loop 去重
```

## 实现计划

### 1. Schema 迁移
- `db.ts` initSchema 中增加 `ALTER TABLE ... ADD COLUMN` 迁移逻辑（IF NOT EXISTS 语义，兼容已有数据库）
- 新增 `idx_usage_tool` 索引

### 2. UsageRecord 接口扩展
- `db.ts` UsageRecord 增加 `contextTokens`, `toolName`, `toolParamsHash` 三个可选字段
- `insertUsage` 的 INSERT 语句和参数列表同步更新

### 3. Event 解析扩展
- `index.ts` handler 中从 diagnostic event 提取：
  - `evt.contextTokens` 或 `evt.context?.tokens`（需确认 OTEL event schema）
  - `evt.toolName` 或 `evt.tool?.name`
  - `evt.toolParams` → SHA-256 hash 前 16 位
- 如果字段不存在，fallback 为默认值（0 / '' / ''）

### 4. Query helpers 扩展
- `getSessionTurns` 返回值增加 `context_tokens`, `tool_name`
- 新增 `getRecentToolCalls(sessionKey, windowMs)` — 返回窗口内的 tool_name + tool_params_hash 列表（供 Sentinel 用）

## 测试计划

### 单元测试
1. Schema 迁移幂等性：连续调用 initSchema 两次不报错
2. 旧数据库兼容：无新列的数据库 → initSchema → 新列存在且默认值正确
3. insertUsage 新字段：插入含 contextTokens/toolName/toolParamsHash 的记录 → 查询验证
4. insertUsage 缺省字段：不传新字段 → 默认值 0/''

### 集成测试
5. 完整 event 流：emit 含 contextTokens + toolName 的 model.usage event → 验证 SQLite 行包含正确值
6. event 缺失字段：emit 不含新字段的 event → 验证 fallback 默认值
7. getSessionTurns 返回新列：验证返回对象包含 context_tokens, tool_name
8. getRecentToolCalls：插入 5 条同 session 记录 → 验证窗口过滤和返回格式

## 前置依赖

- 需确认 OpenClaw diagnostic event 的实际 schema 是否携带 context tokens 和 tool name
- 如果 event 中不携带这些字段，需要向 OpenClaw core 提 PR 或通过 hook context 获取

## 验收标准

- [ ] `usage` 表包含 context_tokens, tool_name, tool_params_hash 三列
- [ ] 旧数据库自动迁移，无数据丢失
- [ ] 新旧格式 event 均能正确入库
- [ ] 所有现有测试继续通过
- [ ] 新增测试覆盖上述 8 个场景
