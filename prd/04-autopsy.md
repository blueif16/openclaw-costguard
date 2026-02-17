# PRD-04: The Autopsy — 会话级成本取证

## 现状

已完成：
- `getSessionTurns(sessionKey)` — 返回 timestamp, model, input/output/cache_read tokens, cost_usd, duration_ms
- `formatSessionReport(sessionKey)` — turn-by-turn 输出：时间、模型、tokens in/out、单次成本、累计成本、耗时
- `/cost session:<key>` 命令路由
- `getCronRunHistory(jobId, limit)` — cron run 对比
- `formatCronReport(jobId, lastN)` — cron run 列表输出

缺失项（核心差异化能力）：
- 无 context_tokens → 无法显示 `ctx: 12K` 和 `context +183%`
- 无 tool_name → 无法显示 `tool: readMessages`
- 无 bloat 自动标注（`← BLOAT`, `← context jumped 112K`）
- 无智能诊断建议（"Likely cause: large tool output persisted to session"）
- 无 context 增长倍数汇总（"Context grew 16.7× from start to finish"）

## 目标功能

`/cost session:<key>` 输出升级为完整的成本取证报告：

```
Session: agent:work:cron:daily-digest:run:47

  #   Time      Cost      Ctx       Model                    Tool           Δ Context
  1   09:12:03  $0.003    12K       anthropic/claude-haiku-4  readMessages
  2   09:12:08  $0.008    34K       anthropic/claude-haiku-4  readMessages   +183%
  3   09:12:15  $0.041    89K       anthropic/claude-haiku-4  web_search     +162%
  4   09:12:22  $0.112    201K      anthropic/claude-haiku-4  Write          +126% ⚠ BLOAT

Total: $0.847 across 12 turns
Context: 12K → 201K (16.7× growth)
⚠ Turn 3→4: context jumped +112K tokens. Likely cause: large tool output persisted to session.
```

### 新增子命令

`/cost session:<key> --compact` — 只显示汇总 + 异常 turn，省略正常 turn

## 实现计划

### 前置：PRD-01 Ledger 补全

以下实现假设 usage 表已包含 context_tokens 和 tool_name 列。

### 1. getSessionTurns 返回值扩展 — `db.ts`

SELECT 增加 `context_tokens, tool_name` 列。返回类型同步更新。

### 2. formatSessionReport 重写 — `formatter.ts`

核心逻辑：
```typescript
function formatSessionReport(sessionKey: string, compact?: boolean): string {
  const turns = getSessionTurns(sessionKey);
  // 计算每个 turn 的 context 增长率
  // 标注 bloat（增长率 > 100% 且绝对增量 > 50K）
  // 汇总：总成本、总 turn 数、context 起止值和增长倍数
  // 列出异常 turn 的诊断建议
}
```

**Context 增长率计算：**
- `deltaPercent = (current.contextTokens - prev.contextTokens) / prev.contextTokens * 100`
- 标注规则：
  - `> 100%` 且绝对增量 `> 50K` → `⚠ BLOAT`
  - `> 50%` → 显示百分比但不标注
  - `≤ 50%` → 不显示

**诊断建议生成（规则引擎，非 LLM）：**
- context jump > 100K 且 tool = Write/bash/readFile → "Likely cause: large tool output persisted to session"
- context jump > 100K 且 tool = web_search → "Likely cause: web search result expanded context"
- 连续 3+ turn context 稳定增长 → "Context compounding detected — consider /compact"
- 最后一个 turn 的 context > 200K → "Session approaching context limit"

### 3. formatCronReport 增强 — `formatter.ts`

每个 run 增加 context 峰值和增长倍数：
```
  2024-02-15 09:00  12 calls  $0.847  201K peak ctx  16.7× growth
  2024-02-14 09:00  8 calls   $0.312  89K peak ctx   4.2× growth  ← normal
```

需要新 query：`getCronRunContextStats(jobId, limit)` — 每个 run 的 MIN/MAX context_tokens。

### 4. --compact 模式 — `formatter.ts`

只输出：
- 汇总行（总成本、turn 数、context 增长）
- 被标注为 BLOAT 的 turn
- 诊断建议

### 5. /cost 命令路由更新 — `index.ts`

解析 `--compact` flag：
```typescript
if (args.startsWith("session:")) {
  const parts = args.split(/\s+/);
  const key = parts[0].slice(8);
  const compact = parts.includes("--compact");
  return formatSessionReport(key, compact);
}
```

## 测试计划

### Context 增长率计算
1. 正常增长：12K → 15K (+25%) → 不标注
2. 中等增长：50K → 80K (+60%) → 显示百分比，不标 BLOAT
3. Bloat：50K → 150K (+200%, +100K) → 标注 `⚠ BLOAT`
4. 小绝对值大百分比：1K → 3K (+200%, +2K) → 不标 BLOAT（absoluteMin 未达标）
5. 首个 turn：无前一条 → 不计算增长率

### 诊断建议
6. context jump 120K + tool=Write → 输出 "large tool output" 建议
7. context jump 120K + tool=web_search → 输出 "web search result" 建议
8. 连续 3 turn 稳定增长 → 输出 "context compounding" 建议
9. 最终 context > 200K → 输出 "approaching limit" 建议
10. 无异常 → 不输出建议

### 汇总信息
11. 总成本正确（= 各 turn cost_usd 之和）
12. Context 增长倍数正确（= last.ctx / first.ctx）
13. Turn 编号连续且正确

### --compact 模式
14. 只包含 BLOAT turn，不包含正常 turn
15. 包含汇总行和诊断建议
16. 无 BLOAT turn 时输出 "No anomalies detected"

### Cron 增强
17. cron report 包含 peak context 和 growth 倍数
18. 多个 run 之间的 growth 对比正确

### 向后兼容
19. context_tokens 全为 0（旧数据）→ 不显示 context 列，不计算增长率，不输出诊断
20. tool_name 全为空（旧数据）→ 不显示 tool 列

### 集成
21. `/cost session:<key>` 完整输出格式验证
22. `/cost session:<key> --compact` 输出格式验证
23. 不存在的 session key → "No data for session: ..."

## 前置依赖

- PRD-01 Ledger 补全（context_tokens, tool_name 列）
- 无 core API 依赖，纯展示层

## 验收标准

- [ ] session report 包含 context tokens、tool name、增长率标注
- [ ] BLOAT 自动标注规则正确触发
- [ ] 诊断建议基于规则引擎生成，覆盖 4 种场景
- [ ] --compact 模式只显示异常和汇总
- [ ] 旧数据（无 context/tool）graceful degradation，不报错不显示空列
- [ ] cron report 增加 context 峰值和增长倍数
- [ ] 所有现有测试继续通过
- [ ] 新增测试覆盖上述 23 个场景
