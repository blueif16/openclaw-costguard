# CostGuard — OpenClaw Cost Tracking Plugin

Real-time cost tracking, budget enforcement, and usage attribution for OpenClaw gateway.

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

## Commands

| Command | Description |
|---|---|
| `/cost` | Today's cost summary |
| `/cost today\|24h\|week\|month` | Cost for period |
| `/cost session:<key>` | Turn-by-turn session autopsy |
| `/cost cron:<jobId> [--last N]` | Cron job run comparison |
| `/cost top [N]` | Top sessions by cost |

## Budget Enforcement

Configure in `openclaw.json` under `plugins.costguard`:

```json
{
  "dailyLimitUsd": 10,
  "monthlyLimitUsd": 200,
  "warnThreshold": 0.8,
  "budgetAction": "warn"
}
```

- `warn` — injects warning into agent context at threshold
- `block` — blocks tool calls when budget exceeded

## Files

| File | Role |
|---|---|
| `src/index.ts` | Plugin entry, service registration, bridge subscription |
| `src/pricing.ts` | LiteLLM fetch, cache, fuzzy match, cost calculation |
| `src/db.ts` | SQLite schema, insert, query helpers |
| `src/attribution.ts` | Session key → source type (user/cron/subagent/acp) |
| `src/budget.ts` | Budget check logic |
| `src/formatter.ts` | `/cost` command output formatting |
