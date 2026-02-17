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

> `npm update openclaw` will overwrite these patches. Re-apply after upgrades.

## Pricing

On startup, fetches [LiteLLM model_prices_and_context_window.json](https://github.com/BerriAI/litellm) (~2100 models). Cached locally at `~/.openclaw/costguard-pricing.json` (24h TTL). Falls back to cache if fetch fails.

Model name matching: exact match → bare name after stripping path prefixes → Dice coefficient fuzzy match (≥0.6 threshold).

## Attribution

Session key is automatically parsed into source types:

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
| `/cost` | Today's cost summary |
| `/cost today\|24h\|week\|month` | Cost for a specific time range |
| `/cost session:<key>` | Per-turn session analysis (context/tool/Δ Context columns, BLOAT flags, diagnostics) |
| `/cost session:<key> --compact` | Show only BLOAT-flagged turns |
| `/cost cron:<jobId> [--last N]` | Cron job run-over-run comparison (peak ctx, growth multiplier) |
| `/cost top [N]` | Top sessions ranked by cost |

## Budget Enforcement

### Basic Configuration

Configure in `openclaw.json` under `plugins.costguard`:

```jsonc
{
  "dailyLimitUsd": 10,
  "weeklyLimitUsd": 50,
  "monthlyLimitUsd": 200,
  "warnThreshold": 0.8,
  "budgetAction": "warn"
}
```

Check order: daily → weekly → monthly. Stops on first hit.

### Multi-Granularity Scopes

Per-agent / per-cron-job independent budgets with wildcard support:

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

Match priority: exact scope → wildcard scope (`cron:*` / `agent:*`) → global limit.

### Three-Tier Response

| Level | Trigger | Behavior |
|---|---|---|
| warn | spend ≥ limit × `warnThreshold` | Injects warning context via `before_agent_start` |
| throttle | spend ≥ limit × `throttleThreshold` | `before_tool_call` returns `{ rewriteModel }` to downgrade model |
| block | spend ≥ limit | `before_tool_call` returns `{ block: true }` to reject the call |

Throttle configuration:

```jsonc
{
  "throttleThreshold": 0.9,
  "throttleFallbackModel": "anthropic/claude-haiku-4"
}
```

## Sentinel — Anomaly Detection

Runs 4 detectors automatically after each `model.usage` event. Alerts are deduplicated (same detector+session suppressed for 5 minutes). Alerts are sent to the configured channel; falls back to logger if no channel is set.

### Detectors

| Detector | Purpose | Key Config |
|---|---|---|
| loopDetection | Detects repeated tool+params calls | `windowSize`(10), `repeatThreshold`(5) |
| contextSpike | Detects sudden context token surges | `growthPercent`(150), `absoluteMin`(50000) |
| costVelocity | Detects short-term cost spikes vs 24h average | `windowMinutes`(5), `multiplier`(3) |
| heartbeatDrift | Detects cron job cost deviating from historical average | `lookbackRuns`(10), `driftPercent`(50) |

Each detector's `action` can be `"warn"` or `"pause"`. `pause` adds the session to the block list.

### Sentinel Configuration Example

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

## Session Report Diagnostics

`/cost session:<key>` output includes:

- Per-turn table: index, timestamp, cost, context tokens, model, tool name, Δ Context change %
- Auto BLOAT flagging: marks `⚠ BLOAT` when a single turn's context grows ≥100% and absolute delta ≥50K tokens
- 4 diagnostic hints:
  - Large tool output inflating context (Write/bash/readFile)
  - Web search results bloating context
  - 3+ consecutive turns of context growth → suggests `/compact`
  - Session approaching context limit (>200K tokens)
- `--compact` mode: shows only BLOAT turns for quick triage

## DB Schema

SQLite stored at `~/.openclaw/costguard.db`, WAL mode.

Core columns: `timestamp`, `session_key`, `agent_id`, `source`, `job_id`, `model`, `provider`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `duration_ms`, `context_tokens`, `tool_name`, `tool_params_hash`

Auto-migration on startup: detects missing columns (`context_tokens`, `tool_name`, `tool_params_hash`) and adds them via `ALTER TABLE`.

## Files

| File | Role |
|---|---|
| `src/index.ts` | Plugin entry, service registration, bridge subscription, hook integration |
| `src/pricing.ts` | LiteLLM fetch, cache, fuzzy match, cost calculation |
| `src/db.ts` | SQLite schema, auto-migration, insert, query helpers |
| `src/attribution.ts` | Session key → source type (user/cron/subagent/acp) |
| `src/budget.ts` | Multi-granularity scope resolution, weekly window, three-tier response (warn/throttle/block) |
| `src/formatter.ts` | `/cost` report formatting, session autopsy, cron report, diagnostics |
| `src/sentinel.ts` | 4 detectors, alert deduplication, channel/logger fallback |
