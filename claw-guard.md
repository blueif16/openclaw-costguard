# openclaw-costguard v0.1 — Build Guide

## What You're Building

An OpenClaw plugin that hooks into the diagnostics event pipeline, records every model invocation to a local SQLite database, exposes a `/cost` slash command, and enforces configurable budget limits. No dashboard. No SaaS. Just the data layer + enforcement that the entire ecosystem is missing.

**Why this matters:** 195K-star repo, 100K+ active installations, and Issue #12299 (1 week old, no assignee) confirms there is literally no programmatic way to answer "how much did I spend today." Every community tool (tokscale, openclaw-dashboard, ClawWatcher, openclaw-token-tracker) exists because this doesn't.

---

## Architecture

```
Provider API (Anthropic/OpenAI/Google/xAI)
        │
        ▼
   pi-ai SDK (raw inference)
        │
        ▼
   OpenClaw Agent Runner
        │
        ├─ emits DiagnosticUsageEvent via hook system
        │
        ▼
   ┌─────────────────────────────────┐
   │  openclaw-costguard plugin       │
   │                                   │
   │  onDiagnosticUsage hook          │
   │       │                           │
   │       ▼                           │
   │  Extract: sessionKey, agentId,    │
   │  model, tokens, source            │
   │       │                           │
   │       ▼                           │
   │  SQLite write (1 row/invocation)  │
   │       │                           │
   │       ├─► /cost slash command     │
   │       └─► Budget enforcement      │
   └─────────────────────────────────┘
```

### Why hooks, not JSONL scraping

Every existing tool parses session JSONL files after the fact. The problems:
- `sessions.json` token fields are misleading (per-message, not cumulative)
- JSONL files mix messages, tool results, compaction entries — parsing is fragile
- No real-time — you only see data on next file read
- Race conditions with compaction/pruning

Your plugin hooks into `onDiagnosticUsage`, the same event the OTEL plugin (diagnostics-otel) uses. This fires after every model invocation with the real token counts directly from the provider response. You're capturing at the source.

---

## Prerequisites

- Node.js ≥22
- A working OpenClaw installation (run `openclaw doctor` to verify)
- Basic TypeScript knowledge
- Familiarity with OpenClaw's plugin system (read: https://deepwiki.com/openclaw/openclaw/10-extensions-and-plugins)

---

## Step 1: Scaffold the Plugin

OpenClaw plugins are npm packages with an `openclaw.extensions` field in `package.json`.

```bash
mkdir openclaw-costguard
cd openclaw-costguard
npm init -y
```

### package.json

```json
{
  "name": "openclaw-costguard",
  "version": "0.1.0",
  "description": "Cost tracking, budget enforcement, and usage attribution for OpenClaw agents",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "license": "MIT",
  "keywords": [
    "openclaw",
    "openclaw-extension",
    "cost-tracking",
    "budget",
    "tokens",
    "observability"
  ],
  "openclaw": {
    "extensions": {
      "costguard": {
        "type": "tool",
        "entrypoint": "./dist/index.js"
      }
    }
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "typescript": "^5.5.0"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
```

---

## Step 2: Understand the Hook System

OpenClaw's plugin hooks are typed event subscriptions. The key hook you need is the diagnostics usage event, which fires after every model invocation.

From the OTEL plugin (PR #11100) and OpenClaw source, the diagnostics event shape is approximately:

```typescript
interface DiagnosticUsageEvent {
  sessionKey: string;       // e.g. "agent:main", "agent:main:cron:emailCheck:run:abc123"
  agentId: string;          // e.g. "main"
  model: string;            // e.g. "anthropic/claude-opus-4-6"
  provider: string;         // e.g. "anthropic"
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs: number;
  timestamp: number;        // epoch ms
}
```

The `sessionKey` encodes the source. Pattern matching:
- `agent:main` → interactive user session
- `agent:main:cron:<jobId>:run:<runId>` → cron job
- `agent:main:heartbeat` or similar → heartbeat
- Keys containing `:subagent:` → spawned subagent

This is how you attribute cost to the right source without any additional plumbing.

---

## Step 3: SQLite Schema

```sql
-- File: schema.sql (for reference, created programmatically)

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,          -- epoch ms
  session_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  source TEXT NOT NULL,                -- 'user' | 'cron' | 'heartbeat' | 'subagent'
  job_id TEXT,                         -- extracted cron job ID, null for user sessions
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  cost_usd REAL NOT NULL,              -- estimated from pricing table
  duration_ms INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage(timestamp);
CREATE INDEX IF NOT EXISTS idx_usage_source ON usage(source);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(model);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_key);
CREATE INDEX IF NOT EXISTS idx_usage_job ON usage(job_id);

-- Daily aggregates for fast queries (materialized by the plugin)
CREATE TABLE IF NOT EXISTS daily_summary (
  date TEXT NOT NULL,                  -- YYYY-MM-DD
  model TEXT NOT NULL,
  source TEXT NOT NULL,
  job_id TEXT,
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cost_usd REAL DEFAULT 0,
  invocation_count INTEGER DEFAULT 0,
  PRIMARY KEY (date, model, source, COALESCE(job_id, ''))
);
```

Why SQLite: Zero config, single file, ships with better-sqlite3 (synchronous, fast), no external dependencies. The DB lives at `~/.openclaw/costguard.db`.

---

## Step 4: Pricing Table

OpenClaw supports many providers. You need a pricing lookup to convert tokens → USD. Start with the major models; fall back to zero cost for unknown models (log a warning).

```typescript
// src/pricing.ts

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

// Prices as of Feb 2026 — update periodically or fetch from LiteLLM
const PRICING: Record<string, ModelPricing> = {
  // Anthropic
  "anthropic/claude-opus-4-6":       { inputPerMillion: 15,  outputPerMillion: 75,  cacheReadPerMillion: 1.5,  cacheWritePerMillion: 18.75 },
  "anthropic/claude-opus-4-5":       { inputPerMillion: 15,  outputPerMillion: 75,  cacheReadPerMillion: 1.5,  cacheWritePerMillion: 18.75 },
  "anthropic/claude-sonnet-4-5":     { inputPerMillion: 3,   outputPerMillion: 15,  cacheReadPerMillion: 0.3,  cacheWritePerMillion: 3.75 },
  "anthropic/claude-haiku-4-5":      { inputPerMillion: 0.8, outputPerMillion: 4,   cacheReadPerMillion: 0.08, cacheWritePerMillion: 1 },
  // OpenAI
  "openai/gpt-5.2":                  { inputPerMillion: 2.5, outputPerMillion: 10 },
  "openai/gpt-5.2-mini":             { inputPerMillion: 0.3, outputPerMillion: 1.2 },
  // Google
  "google/gemini-2.5-pro":           { inputPerMillion: 1.25, outputPerMillion: 10 },
  "google/gemini-2.5-flash":         { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  // xAI
  "xai/grok-4.1":                    { inputPerMillion: 3,   outputPerMillion: 15 },
  // Minimax
  "minimax/m2.5":                    { inputPerMillion: 0.5, outputPerMillion: 2.0 },
};

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0
): number {
  const pricing = PRICING[model];
  if (!pricing) {
    // Try partial match (provider/model variants)
    const match = Object.keys(PRICING).find(k => model.startsWith(k) || model.includes(k.split('/')[1]));
    if (!match) return 0; // Unknown model — log warning, don't crash
    return estimateCost(match, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * (pricing.cacheReadPerMillion ?? pricing.inputPerMillion);
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * (pricing.cacheWritePerMillion ?? pricing.inputPerMillion);

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

export function getKnownModels(): string[] {
  return Object.keys(PRICING);
}
```

Note: For v0.1, hardcoded pricing is fine. For v0.2, fetch from LiteLLM's pricing API (same approach tokscale uses — 1h disk cache).

---

## Step 5: Core Database Module

```typescript
// src/db.ts

import Database from "better-sqlite3";
import path from "path";
import os from "os";

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
const DB_PATH = path.join(OPENCLAW_HOME, "costguard.db");

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL"); // Better concurrent read performance
    db.pragma("busy_timeout = 5000");
    initSchema(db);
  }
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      session_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      source TEXT NOT NULL,
      job_id TEXT,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cost_usd REAL NOT NULL,
      duration_ms INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_source ON usage(source);
    CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(model);
    CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_key);
    CREATE INDEX IF NOT EXISTS idx_usage_job ON usage(job_id);
  `);
}

export interface UsageRecord {
  timestamp: number;
  sessionKey: string;
  agentId: string;
  source: string;
  jobId: string | null;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
}

export function insertUsage(record: UsageRecord): void {
  const stmt = getDb().prepare(`
    INSERT INTO usage (timestamp, session_key, agent_id, source, job_id, model, provider,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    record.timestamp, record.sessionKey, record.agentId, record.source,
    record.jobId, record.model, record.provider,
    record.inputTokens, record.outputTokens, record.cacheReadTokens,
    record.cacheWriteTokens, record.costUsd, record.durationMs
  );
}

// --- Query helpers ---

export interface CostSummary {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  invocationCount: number;
}

export function getCostSince(sinceMs: number): CostSummary {
  return getDb().prepare(`
    SELECT
      COALESCE(SUM(cost_usd), 0) as totalCost,
      COALESCE(SUM(input_tokens), 0) as totalInputTokens,
      COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
      COUNT(*) as invocationCount
    FROM usage WHERE timestamp >= ?
  `).get(sinceMs) as CostSummary;
}

export function getCostByModel(sinceMs: number): Array<{ model: string } & CostSummary> {
  return getDb().prepare(`
    SELECT model,
      COALESCE(SUM(cost_usd), 0) as totalCost,
      COALESCE(SUM(input_tokens), 0) as totalInputTokens,
      COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
      COUNT(*) as invocationCount
    FROM usage WHERE timestamp >= ?
    GROUP BY model ORDER BY totalCost DESC
  `).all(sinceMs) as Array<{ model: string } & CostSummary>;
}

export function getCostBySource(sinceMs: number): Array<{ source: string; job_id: string | null } & CostSummary> {
  return getDb().prepare(`
    SELECT source, job_id,
      COALESCE(SUM(cost_usd), 0) as totalCost,
      COALESCE(SUM(input_tokens), 0) as totalInputTokens,
      COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
      COUNT(*) as invocationCount
    FROM usage WHERE timestamp >= ?
    GROUP BY source, job_id ORDER BY totalCost DESC
  `).all(sinceMs) as Array<{ source: string; job_id: string | null } & CostSummary>;
}

export function getCostBySession(sinceMs: number, limit: number = 10): Array<{ session_key: string } & CostSummary> {
  return getDb().prepare(`
    SELECT session_key,
      COALESCE(SUM(cost_usd), 0) as totalCost,
      COALESCE(SUM(input_tokens), 0) as totalInputTokens,
      COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
      COUNT(*) as invocationCount
    FROM usage WHERE timestamp >= ?
    GROUP BY session_key ORDER BY totalCost DESC LIMIT ?
  `).all(sinceMs, limit) as Array<{ session_key: string } & CostSummary>;
}

export function getDailyTotals(days: number = 30): Array<{ date: string; totalCost: number; totalTokens: number }> {
  const sinceMs = Date.now() - (days * 24 * 60 * 60 * 1000);
  return getDb().prepare(`
    SELECT
      DATE(timestamp / 1000, 'unixepoch', 'localtime') as date,
      COALESCE(SUM(cost_usd), 0) as totalCost,
      COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens
    FROM usage WHERE timestamp >= ?
    GROUP BY date ORDER BY date ASC
  `).all(sinceMs) as Array<{ date: string; totalCost: number; totalTokens: number }>;
}
```

---

## Step 6: Source Attribution Parser

```typescript
// src/attribution.ts

export interface Attribution {
  source: "user" | "cron" | "heartbeat" | "subagent";
  jobId: string | null;
}

/**
 * Parse a sessionKey to determine the source of the invocation.
 *
 * Session key patterns observed in OpenClaw:
 *   "agent:main"                                    → user (interactive)
 *   "agent:main:cron:<jobId>:run:<runId>"           → cron
 *   "agent:main:heartbeat"                          → heartbeat
 *   "agent:main:subagent:<name>:<id>"               → subagent
 *   "agent:<agentId>"                               → user (non-main agent)
 *   "agent:<agentId>:cron:<jobId>:run:<runId>"      → cron (non-main)
 *
 * These patterns may evolve. If unrecognized, default to "user".
 */
export function parseSessionKey(sessionKey: string): Attribution {
  // Heartbeat
  if (sessionKey.includes(":heartbeat")) {
    return { source: "heartbeat", jobId: null };
  }

  // Cron job — extract jobId
  const cronMatch = sessionKey.match(/:cron:([^:]+):run:/);
  if (cronMatch) {
    return { source: "cron", jobId: cronMatch[1] };
  }

  // Subagent
  if (sessionKey.includes(":subagent:")) {
    return { source: "subagent", jobId: null };
  }

  // Default: interactive user session
  return { source: "user", jobId: null };
}
```

---

## Step 7: Budget Enforcement

```typescript
// src/budget.ts

import { getCostSince } from "./db.js";

export interface BudgetConfig {
  dailyLimitUsd?: number;    // e.g. 10.00
  monthlyLimitUsd?: number;  // e.g. 200.00
  action: "warn" | "block";  // warn = log + continue, block = reject the turn
}

export interface BudgetCheck {
  exceeded: boolean;
  type?: "daily" | "monthly";
  currentSpend: number;
  limit: number;
  message: string;
}

export function checkBudget(config: BudgetConfig): BudgetCheck {
  const now = Date.now();

  // Daily check
  if (config.dailyLimitUsd != null) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const daily = getCostSince(startOfDay.getTime());

    if (daily.totalCost >= config.dailyLimitUsd) {
      return {
        exceeded: true,
        type: "daily",
        currentSpend: daily.totalCost,
        limit: config.dailyLimitUsd,
        message: `⚠️ Daily budget exceeded: $${daily.totalCost.toFixed(2)} / $${config.dailyLimitUsd.toFixed(2)}`
      };
    }
  }

  // Monthly check
  if (config.monthlyLimitUsd != null) {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const monthly = getCostSince(startOfMonth.getTime());

    if (monthly.totalCost >= config.monthlyLimitUsd) {
      return {
        exceeded: true,
        type: "monthly",
        currentSpend: monthly.totalCost,
        limit: config.monthlyLimitUsd,
        message: `⚠️ Monthly budget exceeded: $${monthly.totalCost.toFixed(2)} / $${monthly.totalCost.toFixed(2)}`
      };
    }
  }

  return { exceeded: false, currentSpend: 0, limit: 0, message: "" };
}
```

---

## Step 8: Slash Command Formatter

```typescript
// src/formatter.ts

import { getCostSince, getCostByModel, getCostBySource, getDailyTotals, type CostSummary } from "./db.js";

function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function timeRange(label: string): number {
  const now = Date.now();
  switch (label) {
    case "today": {
      const d = new Date(); d.setHours(0,0,0,0); return d.getTime();
    }
    case "week": return now - 7 * 24 * 60 * 60 * 1000;
    case "month": {
      const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d.getTime();
    }
    case "24h":
    default: return now - 24 * 60 * 60 * 1000;
  }
}

export function formatCostReport(period: string = "today"): string {
  const sinceMs = timeRange(period);
  const summary = getCostSince(sinceMs);
  const byModel = getCostByModel(sinceMs);
  const bySource = getCostBySource(sinceMs);

  const lines: string[] = [];

  // Header
  lines.push(`💰 **Cost Report — ${period}**`);
  lines.push("");

  // Totals
  lines.push(`Total: **${formatUsd(summary.totalCost)}** across ${summary.invocationCount} API calls`);
  lines.push(`Tokens: ${formatTokens(summary.totalInputTokens)} in / ${formatTokens(summary.totalOutputTokens)} out`);
  lines.push("");

  // By model
  if (byModel.length > 0) {
    lines.push("**By model:**");
    for (const row of byModel) {
      lines.push(`  ${row.model}: ${formatUsd(row.totalCost)} (${row.invocationCount} calls)`);
    }
    lines.push("");
  }

  // By source
  if (bySource.length > 0) {
    lines.push("**By source:**");
    for (const row of bySource) {
      const label = row.job_id ? `cron/${row.job_id}` : row.source;
      lines.push(`  ${label}: ${formatUsd(row.totalCost)} (${row.invocationCount} calls)`);
    }
  }

  return lines.join("\n");
}
```

---

## Step 9: Main Plugin Entry Point

This is where it all comes together. The plugin registers hooks and handles slash commands.

```typescript
// src/index.ts

import { estimateCost } from "./pricing.js";
import { insertUsage } from "./db.js";
import { parseSessionKey } from "./attribution.js";
import { checkBudget, type BudgetConfig } from "./budget.js";
import { formatCostReport } from "./formatter.js";

// The plugin config shape (user sets in openclaw.json)
interface CostguardConfig {
  enabled?: boolean;
  dailyLimitUsd?: number;
  monthlyLimitUsd?: number;
  budgetAction?: "warn" | "block";
}

/**
 * OpenClaw Plugin Entry Point
 *
 * NOTE: The exact hook API depends on the OpenClaw version.
 * This follows the pattern from diagnostics-otel and the plugin docs.
 * You MUST verify the exact hook names and signatures against the
 * current OpenClaw source before publishing.
 *
 * Key references:
 *   - PR #11100 (diagnostics-otel): hook registration pattern
 *   - src/diagnostics/types.ts: DiagnosticUsageEvent shape
 *   - packages/plugin-sdk: plugin lifecycle types
 */
export default function costguardPlugin(context: any) {
  const config: CostguardConfig = context.config ?? {};

  if (config.enabled === false) return;

  const budgetConfig: BudgetConfig = {
    dailyLimitUsd: config.dailyLimitUsd,
    monthlyLimitUsd: config.monthlyLimitUsd,
    action: config.budgetAction ?? "warn",
  };

  // --- Hook: Diagnostics Usage Event ---
  // This fires after every model invocation with real token counts.
  // The exact hook name may be: onDiagnosticUsage, onUsage, diagnostics.usage
  // Verify against OpenClaw source.
  context.hooks.on("diagnostics.usage", (event: any) => {
    try {
      const { source, jobId } = parseSessionKey(event.sessionKey ?? "");

      const costUsd = estimateCost(
        event.model ?? "",
        event.inputTokens ?? 0,
        event.outputTokens ?? 0,
        event.cacheReadTokens ?? 0,
        event.cacheWriteTokens ?? 0
      );

      insertUsage({
        timestamp: event.timestamp ?? Date.now(),
        sessionKey: event.sessionKey ?? "unknown",
        agentId: event.agentId ?? "unknown",
        source,
        jobId,
        model: event.model ?? "unknown",
        provider: event.provider ?? "unknown",
        inputTokens: event.inputTokens ?? 0,
        outputTokens: event.outputTokens ?? 0,
        cacheReadTokens: event.cacheReadTokens ?? 0,
        cacheWriteTokens: event.cacheWriteTokens ?? 0,
        costUsd,
        durationMs: event.durationMs ?? 0,
      });

      // Budget check
      const check = checkBudget(budgetConfig);
      if (check.exceeded) {
        if (budgetConfig.action === "block") {
          // How to block depends on the hook API.
          // Options: throw an error, set a flag the agent runner checks,
          // or use context.agent.pause() if available.
          context.log?.warn?.(check.message);
          // For v0.1, just warn. Blocking requires deeper integration.
        } else {
          context.log?.warn?.(check.message);
        }
      }
    } catch (err) {
      context.log?.error?.("costguard: failed to record usage", err);
    }
  });

  // --- Slash Command: /cost ---
  // Registers a slash command the user can send in any channel.
  // The exact registration API may differ — verify against OpenClaw plugin docs.
  context.commands?.register?.({
    name: "cost",
    description: "Show cost summary",
    handler: (args: string) => {
      const period = args?.trim() || "today";
      // Valid periods: today, 24h, week, month
      const validPeriods = ["today", "24h", "week", "month"];
      const selectedPeriod = validPeriods.includes(period) ? period : "today";
      return formatCostReport(selectedPeriod);
    },
  });

  context.log?.info?.("costguard: initialized");
}
```

---

## Step 10: Plugin Configuration

Users add this to their `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "allow": ["openclaw-costguard"],
    "entries": {
      "openclaw-costguard": {
        "enabled": true,
        "config": {
          "dailyLimitUsd": 25.00,
          "monthlyLimitUsd": 300.00,
          "budgetAction": "warn"    // "warn" or "block"
        }
      }
    }
  }
}
```

Then install and restart:

```bash
npm install -g openclaw-costguard
openclaw gateway restart
```

---

## Step 11: Test Locally

Before publishing, test against a live OpenClaw instance.

### 1. Build

```bash
cd openclaw-costguard
npm install
npm run build
```

### 2. Link locally

```bash
# Point OpenClaw to your local plugin
# In openclaw.json:
{
  "plugins": {
    "load": {
      "paths": ["/path/to/openclaw-costguard"]
    },
    "entries": {
      "openclaw-costguard": {
        "enabled": true,
        "config": {
          "dailyLimitUsd": 5.00
        }
      }
    }
  }
}
```

### 3. Restart and verify

```bash
# Clear cache and restart
rm -rf /tmp/jiti
openclaw gateway restart

# Check logs for initialization
openclaw logs --follow | grep costguard

# Send a test message to trigger a model invocation
openclaw agent --message "ping"

# Check the DB was written
sqlite3 ~/.openclaw/costguard.db "SELECT * FROM usage ORDER BY id DESC LIMIT 5;"
```

### 4. Test the slash command

Send `/cost` or `/cost week` in any connected channel (WhatsApp, Telegram, Slack, etc.).

Expected output:
```
💰 Cost Report — today

Total: $1.2340 across 15 API calls
Tokens: 45.2K in / 12.8K out

By model:
  anthropic/claude-opus-4-6: $0.9800 (8 calls)
  anthropic/claude-haiku-4-5: $0.2540 (7 calls)

By source:
  user: $0.6200 (5 calls)
  cron/emailCheck: $0.4100 (6 calls)
  heartbeat: $0.2040 (4 calls)
```

---

## Step 12: Publish to npm + ClawHub

### npm

```bash
npm publish
```

### ClawHub

Follow the skill/plugin submission guide at https://github.com/openclaw/skills. Your plugin needs a SKILL.md at minimum:

```markdown
---
name: costguard
description: "Cost tracking, budget enforcement, and usage attribution for OpenClaw"
---

# costguard

Track cumulative API costs across sessions, cron jobs, heartbeats, and subagents.
Set daily/monthly budget limits. Query spend with `/cost`.

## Install

\`\`\`bash
npm install -g openclaw-costguard
\`\`\`

## Usage

Send `/cost` in any channel. Options: `/cost today`, `/cost week`, `/cost month`.

## Config

Add to `openclaw.json` → `plugins.entries.openclaw-costguard.config`:

- `dailyLimitUsd`: Daily spend limit in USD (default: none)
- `monthlyLimitUsd`: Monthly spend limit in USD (default: none)
- `budgetAction`: `"warn"` (log warning) or `"block"` (reject turn)
```

---

## Known Risks and Gotchas

### 1. Hook API is not stable

The diagnostics hook name and event shape changed significantly with PR #11100 (6 days ago). It may change again. Before building, clone the OpenClaw repo and check:
- `src/diagnostics/types.ts` for the event interface
- `src/diagnostics/emitter.ts` for how events are fired
- `extensions/diagnostics-otel/src/` for how the OTEL plugin subscribes

If the hook name is wrong, your plugin silently does nothing.

### 2. OAuth users see no cost

Users on Claude Pro/Max subscriptions via OAuth don't pay per-token — they pay a flat monthly fee. Your cost estimates will show phantom costs for them. Add a note in the output or detect OAuth sessions and show tokens only (match OpenClaw's `/status` behavior).

### 3. better-sqlite3 native module

`better-sqlite3` is a native Node addon. It compiles on install. This can fail on some platforms (ARM, Alpine Linux, unusual Node versions). If this becomes a blocker for adoption, consider falling back to a pure-JS SQLite like `sql.js` at the cost of some performance.

### 4. Budget "block" mode is hard

Actually blocking an agent turn requires deeper integration than just logging a warning. The plugin hook may not have a mechanism to reject the turn. For v0.1, "warn" mode is the safe default. "block" can be explored in v0.2 by either:
- Throwing inside the hook (if the agent runner catches and aborts)
- Writing a flag file that a custom AGENTS.md rule checks
- Using the gateway's tool deny mechanism to temporarily disable expensive tools

### 5. Session key patterns may change

The `sessionKey` parsing in `attribution.ts` is based on observed patterns. If OpenClaw changes their key format, your attribution breaks silently. Add logging for unrecognized patterns so you can adapt.

---

## What v0.2 Looks Like

Once v0.1 is validated:

1. **Live pricing from LiteLLM** — fetch `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`, cache 1h
2. **Budget blocking** — deeper integration to actually pause the agent
3. **Webhook alerts** — POST to a URL when budget thresholds hit (70%, 90%, 100%)
4. **`openclaw cost` CLI** — register a CLI subcommand for terminal-based queries
5. **Export** — `openclaw cost export --format csv --since 2026-02-01`
6. **Lightweight bundled web UI** — single HTML file served from the plugin, like OpenClaw's own Control UI pattern. Queries the SQLite DB. No React, no build step.

---

## File Structure

```
openclaw-costguard/
├── package.json
├── tsconfig.json
├── SKILL.md
├── README.md
├── LICENSE
└── src/
    ├── index.ts          # Plugin entry point + hook registration
    ├── db.ts             # SQLite schema, writes, queries
    ├── pricing.ts        # Model → USD/M token pricing table
    ├── attribution.ts    # Session key → source parser
    ├── budget.ts         # Budget limit checking
    └── formatter.ts      # /cost slash command output formatter
```

Total: ~6 files, ~500 lines of TypeScript. Shippable in a weekend.