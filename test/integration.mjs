/**
 * Integration test for costguard plugin.
 *
 * Simulates diagnostic events, verifies SQLite writes, query helpers,
 * budget checks, session key parsing, and /cost command output.
 *
 * Run: OPENCLAW_HOME=/tmp/costguard-test node --experimental-sqlite test/integration.mjs
 */

import { mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

// --- Setup: temp directory for SQLite ---
const TEST_DIR = "/tmp/costguard-test";
rmSync(TEST_DIR, { recursive: true, force: true });
mkdirSync(TEST_DIR, { recursive: true });
process.env.OPENCLAW_HOME = TEST_DIR;

// --- Mock onDiagnosticEvent ---
let diagnosticListener = null;

// Intercept require("openclaw/plugin-sdk") — we need to provide the mock
// Since the plugin imports from "openclaw/plugin-sdk", we patch Module._resolveFilename
import { createRequire } from "node:module";
import Module from "node:module";

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "openclaw/plugin-sdk") {
    // Return a fake path; we'll intercept the actual load
    return "__mock_openclaw_plugin_sdk__";
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "__mock_openclaw_plugin_sdk__" || request === "openclaw/plugin-sdk") {
    return {
      onDiagnosticEvent(listener) {
        diagnosticListener = listener;
        return () => { diagnosticListener = null; };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// --- Now import the plugin (after mocks are in place) ---
const mod = await import("../dist/index.js");
const plugin = mod.default?.default ?? mod.default ?? mod;

// --- Test harness ---
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function assertApprox(actual, expected, tolerance, msg) {
  assert(Math.abs(actual - expected) < tolerance, `${msg} (got ${actual}, expected ~${expected})`);
}

// --- Collect registered hooks/commands/services ---
const registered = { services: [], commands: [], hooks: {} };

const mockApi = {
  pluginConfig: {
    dailyLimitUsd: 5.0,
    monthlyLimitUsd: 100.0,
    warnThreshold: 0.8,
    budgetAction: "block",
  },
  logger: {
    info: (...args) => {},
    warn: (...args) => {},
    error: (...args) => console.error("[error]", ...args),
  },
  registerService(svc) { registered.services.push(svc); },
  registerCommand(cmd) { registered.commands.push(cmd); },
  registerHook(event, handler) {
    if (!registered.hooks[event]) registered.hooks[event] = [];
    registered.hooks[event].push(handler);
  },
};

// ============================================================
console.log("\n=== 1. Plugin Registration ===");
plugin.register(mockApi);

assert(registered.services.length === 1, "registerService called once");
assert(registered.services[0].id === "costguard", "service id = costguard");
assert(registered.commands.length === 1, "registerCommand called once");
assert(registered.commands[0].name === "cost", "command name = cost");
assert(registered.commands[0].acceptsArgs === true, "command acceptsArgs = true");
assert(!!registered.hooks["before_tool_call"], "before_tool_call hook registered");
assert(!!registered.hooks["before_agent_start"], "before_agent_start hook registered");

// ============================================================
console.log("\n=== 2. Service Start + Diagnostic Listener ===");
const mockCtx = { logger: mockApi.logger };
await registered.services[0].start(mockCtx);
assert(typeof diagnosticListener === "function", "diagnosticListener attached");

// ============================================================
console.log("\n=== 3. Emit Diagnostic Events ===");

const events = [
  {
    type: "model.usage",
    sessionKey: "agent:main:main",
    provider: "anthropic",
    model: "anthropic/claude-opus-4-6",
    usage: { input: 5000, output: 1000, cacheRead: 2000, cacheWrite: 500 },
    costUsd: 0.12,
    durationMs: 3200,
  },
  {
    type: "model.usage",
    sessionKey: "agent:main:cron:daily-digest:run:001",
    provider: "anthropic",
    model: "anthropic/claude-sonnet-4-5",
    usage: { input: 10000, output: 2000, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0.06,
    durationMs: 1500,
  },
  {
    type: "model.usage",
    sessionKey: "agent:main:subagent:abc-123",
    provider: "openai",
    model: "openai/gpt-5.2",
    usage: { input: 3000, output: 800, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0.015,
    durationMs: 900,
  },
  {
    type: "model.usage",
    sessionKey: "agent:main:acp:tool-server",
    provider: "google",
    model: "google/gemini-2.5-pro",
    usage: { input: 8000, output: 1500, cacheRead: 1000, cacheWrite: 0 },
    costUsd: 0.025,
    durationMs: 2100,
  },
  // Non-usage event — should be ignored
  {
    type: "webhook.received",
    channel: "telegram",
  },
];

for (const evt of events) {
  diagnosticListener(evt);
}

// ============================================================
console.log("\n=== 4. Verify SQLite Data ===");

const dbPath = path.join(TEST_DIR, "costguard.db");
const verifyDb = new DatabaseSync(dbPath, { readOnly: true });

const count = verifyDb.prepare("SELECT COUNT(*) as c FROM usage").get();
assert(count.c === 4, `4 rows inserted (got ${count.c})`);

const sources = verifyDb.prepare("SELECT DISTINCT source FROM usage ORDER BY source").all();
const sourceList = sources.map(r => r.source).sort();
assert(JSON.stringify(sourceList) === JSON.stringify(["acp", "cron", "subagent", "user"]),
  `sources = [acp, cron, subagent, user] (got ${JSON.stringify(sourceList)})`);

const cronRow = verifyDb.prepare("SELECT job_id FROM usage WHERE source = 'cron'").get();
assert(cronRow.job_id === "daily-digest", `cron jobId = daily-digest (got ${cronRow.job_id})`);

const totalCost = verifyDb.prepare("SELECT SUM(cost_usd) as total FROM usage").get();
assertApprox(totalCost.total, 0.22, 0.001, "total cost ≈ $0.22");

verifyDb.close();

// ============================================================
console.log("\n=== 5. Query Helpers ===");

// Import db module to test query functions
const db = await import("../dist/db.js");

const summary = db.getCostSince(0);
assert(summary.invocationCount === 4, `invocationCount = 4 (got ${summary.invocationCount})`);
assertApprox(summary.totalCost, 0.22, 0.001, "getCostSince totalCost ≈ $0.22");

const byModel = db.getCostByModel(0);
assert(byModel.length === 4, `4 distinct models (got ${byModel.length})`);
assert(byModel[0].model === "anthropic/claude-opus-4-6", `top model by cost = opus (got ${byModel[0].model})`);

const bySource = db.getCostBySource(0);
assert(bySource.length === 4, `4 source groups (got ${bySource.length})`);

const sessionTurns = db.getSessionTurns("agent:main:main");
assert(sessionTurns.length === 1, `1 turn for main session (got ${sessionTurns.length})`);

const cronHistory = db.getCronRunHistory("daily-digest", 5);
assert(cronHistory.length === 1, `1 cron run (got ${cronHistory.length})`);

// ============================================================
console.log("\n=== 6. /cost Command Routing ===");

const costCmd = registered.commands[0];

const defaultReport = costCmd.handler({ args: "" });
assert(defaultReport.text.includes("Cost Report"), "default: contains 'Cost Report'");
assert(defaultReport.text.includes("$0.22"), "default: contains total cost");

const sessionReport = costCmd.handler({ args: "session:agent:main:main" });
assert(sessionReport.text.includes("Session Autopsy"), "session: contains 'Session Autopsy'");

const cronReport = costCmd.handler({ args: "cron:daily-digest --last 3" });
assert(cronReport.text.includes("Cron Job"), "cron: contains 'Cron Job'");

const topReport = costCmd.handler({ args: "top 5" });
assert(topReport.text.includes("Top"), "top: contains 'Top'");

// ============================================================
console.log("\n=== 7. Budget Enforcement (before_tool_call) ===");

// Current spend is $0.22, daily limit is $5 — should NOT block
const toolHook = registered.hooks["before_tool_call"][0];
const toolResult = toolHook({ toolName: "bash", params: {} }, { sessionKey: "agent:main:main" });
assert(toolResult === undefined, "under budget: tool not blocked");

// Pump events to exceed $5 daily limit
for (let i = 0; i < 50; i++) {
  diagnosticListener({
    type: "model.usage",
    sessionKey: "agent:main:main",
    provider: "anthropic",
    model: "anthropic/claude-opus-4-6",
    usage: { input: 50000, output: 10000, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0.15,
    durationMs: 1000,
  });
}

const blockedResult = toolHook({ toolName: "bash", params: {} }, { sessionKey: "agent:main:main" });
assert(blockedResult?.block === true, "over budget: tool blocked");
assert(typeof blockedResult?.blockReason === "string" && blockedResult.blockReason.includes("exceeded"),
  `blockReason contains 'exceeded' (got: ${blockedResult?.blockReason})`);

// ============================================================
console.log("\n=== 8. Budget Warning (before_agent_start) ===");

// Reset by testing with a fresh scenario — the agent start hook checks lastBudgetCheck
const agentHook = registered.hooks["before_agent_start"][0];
const agentResult = agentHook({ prompt: "hello" }, { sessionKey: "agent:main:main" });
assert(agentResult?.prependContext?.includes("CostGuard"),
  `prependContext contains CostGuard warning (got: ${agentResult?.prependContext?.slice(0, 60)})`);

// ============================================================
console.log("\n=== 9. Service Stop ===");
await registered.services[0].stop(mockCtx);
assert(diagnosticListener === null, "diagnosticListener detached after stop");

// ============================================================
// Cleanup
rmSync(TEST_DIR, { recursive: true, force: true });

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
