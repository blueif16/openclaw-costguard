import { createHash } from "node:crypto";
import { estimateCost, refreshPricing } from "./pricing.js";
import { insertUsage, closeDb } from "./db.js";
import { parseSessionKey } from "./attribution.js";
import { checkBudget, type BudgetConfig } from "./budget.js";
import { formatCostReport, formatSessionReport, formatCronReport, formatTopSessions } from "./formatter.js";
import { checkAfterEvent, sendAlert, type SentinelConfig } from "./sentinel.js";

interface PluginApi {
  pluginConfig?: Record<string, any>;
  logger?: { info?: (...a: any[]) => void; warn?: (...a: any[]) => void; error?: (...a: any[]) => void };
  registerService: (service: { id: string; start: (ctx: any) => Promise<void>; stop?: (ctx: any) => Promise<void> }) => void;
  registerCommand: (cmd: { name: string; description: string; acceptsArgs?: boolean; requireAuth?: boolean; handler: (ctx: any) => any }) => void;
  registerHook: (events: string | string[], handler: (...args: any[]) => any, opts?: { name: string; description?: string }) => void;
}

let budgetConfig: BudgetConfig;
let sentinelConfig: SentinelConfig;
let lastBudgetCheck: { level: string; message: string } = { level: "ok", message: "" };

const plugin = {
  id: "costguard",
  name: "Cost Guard",
  description: "Cost tracking, budget enforcement, and usage attribution for OpenClaw agents",

  register(api: PluginApi) {
    const cfg = api.pluginConfig ?? {};
    budgetConfig = {
      dailyLimitUsd: cfg.dailyLimitUsd,
      weeklyLimitUsd: cfg.weeklyLimitUsd,
      monthlyLimitUsd: cfg.monthlyLimitUsd,
      warnThreshold: cfg.warnThreshold ?? 0.8,
      throttleThreshold: cfg.throttleThreshold,
      throttleFallbackModel: cfg.throttleFallbackModel,
      action: cfg.budgetAction ?? "warn",
      scopes: cfg.scopes,
    };

    sentinelConfig = cfg.sentinel ?? {};

    // --- Service: diagnostic event listener + SQLite ---
    api.registerService({
      id: "costguard",
      async start(ctx: any) {
        ctx.logger?.info?.("costguard: starting");

        // Load pricing data from LiteLLM
        const pricingResult = await refreshPricing();
        ctx.logger?.info?.(`costguard: pricing loaded (${pricingResult.count} models from ${pricingResult.source})`);

        // Bridge: subscribe via globalThis Symbol to receive events from the loader's emitter
        const BRIDGE_KEY = Symbol.for("openclaw.diagnosticBridge");
        if (!(globalThis as any)[BRIDGE_KEY]) {
          (globalThis as any)[BRIDGE_KEY] = new Set();
        }
        const bridgeSet: Set<(evt: any) => void> = (globalThis as any)[BRIDGE_KEY];

        const handler = (evt: any) => {
          // ctx.logger?.info?.(`costguard: bridge event type=${evt.type}`);
          if (evt.type !== "model.usage") return;
          try {
            const sessionKey = evt.sessionKey ?? "";
            const { source, jobId } = parseSessionKey(sessionKey);
            const model = evt.model ?? "unknown";
            const usage = evt.usage ?? {};
            const inTokens = usage.input ?? usage.promptTokens ?? 0;
            const outTokens = usage.output ?? 0;
            const cacheRead = usage.cacheRead ?? 0;
            const cacheWrite = usage.cacheWrite ?? 0;
            const estimated = estimateCost(model, inTokens, outTokens, cacheRead, cacheWrite);
            const costUsd = evt.costUsd || estimated.cost;
            if (estimated.matchedModel && estimated.matchedModel !== model) {
              ctx.logger?.info?.(`costguard: ${model} → matched pricing: ${estimated.matchedModel}`);
            }

            // PRD-01: extract context_tokens, tool_name, tool_params_hash
            const contextTokens = evt.contextTokens ?? evt.context?.tokens ?? 0;
            const toolName = evt.toolName ?? evt.tool?.name ?? '';
            const rawParams = evt.toolParams ?? evt.tool?.params;
            const toolParamsHash = rawParams
              ? createHash("sha256").update(JSON.stringify(rawParams)).digest("hex").slice(0, 16)
              : '';

            insertUsage({
              timestamp: Date.now(),
              sessionKey,
              agentId: evt.agentId ?? "unknown",
              source,
              jobId,
              model,
              provider: evt.provider ?? "unknown",
              inputTokens: inTokens,
              outputTokens: outTokens,
              cacheReadTokens: cacheRead,
              cacheWriteTokens: cacheWrite,
              costUsd,
              durationMs: evt.durationMs ?? 0,
              contextTokens,
              toolName,
              toolParamsHash,
            });

            lastBudgetCheck = checkBudget(budgetConfig, sessionKey, jobId);
            if (lastBudgetCheck.level !== "ok") {
              ctx.logger?.warn?.(`costguard: ${lastBudgetCheck.message}`);
            }

            // PRD-03: Sentinel anomaly detection
            const record = {
              timestamp: Date.now(), sessionKey, agentId: evt.agentId ?? "unknown",
              source, jobId, model, provider: evt.provider ?? "unknown",
              inputTokens: inTokens, outputTokens: outTokens,
              cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
              costUsd, durationMs: evt.durationMs ?? 0,
              contextTokens, toolName, toolParamsHash,
            };
            const alerts = checkAfterEvent(record, sentinelConfig);
            for (const alert of alerts) {
              sendAlert(alert, sentinelConfig.alertChannel, ctx);
              if (alert.action === "pause") {
                (ctx as any)._costguardSessionBlocked ??= new Set();
                (ctx as any)._costguardSessionBlocked.add(alert.sessionKey);
              }
            }
          } catch (err) {
            ctx.logger?.error?.("costguard: failed to record usage", err);
          }
        };

        bridgeSet.add(handler);
        (ctx as any)._costguardUnsub = () => bridgeSet.delete(handler);
        ctx.logger?.info?.("costguard: listening for model.usage events via globalThis bridge");
      },
      async stop(ctx: any) {
        (ctx as any)._costguardUnsub?.();
        closeDb();
        ctx.logger?.info?.("costguard: stopped");
      },
    });

    // --- Hook: before_tool_call — budget enforcement (block + throttle) ---
    if (budgetConfig.action === "block") {
      api.registerHook("before_tool_call", (event: any, _ctx: any) => {
        const sk = event?.sessionKey ?? "";
        const jid = event?.jobId ?? null;
        const result = checkBudget(budgetConfig, sk, jid);
        if (result.level === "exceeded") {
          return { block: true, blockReason: result.message };
        }
        if (result.level === "throttle" && result.fallbackModel) {
          return { rewriteModel: result.fallbackModel };
        }
      }, { name: "costguard:budget-block" });
    }

    // --- Hook: before_agent_start — budget warning injection ---
    api.registerHook("before_agent_start", (event: any, _ctx: any) => {
      const sk = event?.sessionKey ?? "";
      const jid = event?.jobId ?? null;
      const result = checkBudget(budgetConfig, sk, jid);
      if (result.level === "warning" || result.level === "throttle") {
        return { prependContext: `[CostGuard Warning] ${result.message}` };
      }
      if (result.level === "exceeded") {
        return { prependContext: `[CostGuard Alert] ${result.message}` };
      }
    }, { name: "costguard:budget-warn" });

    // --- Command: /cost ---
    api.registerCommand({
      name: "cost",
      description: "Show cost summary. Usage: /cost [today|24h|week|month] | /cost session:<key> | /cost cron:<jobId> [--last N] | /cost top [N]",
      acceptsArgs: true,
      requireAuth: true,
      handler(ctx: any) {
        const args = (ctx.args ?? "").trim();
        return { text: routeCostCommand(args) };
      },
    });

    api.logger?.info?.("costguard: registered");
  },
};

function routeCostCommand(args: string): string {
  if (!args) return formatCostReport("today");

  // /cost session:<key> [--compact]
  if (args.startsWith("session:")) {
    const parts = args.split(/\s+/);
    const key = parts[0].slice(8);
    const compact = parts.includes("--compact");
    return formatSessionReport(key, compact);
  }

  // /cost cron:<jobId> [--last N]
  if (args.startsWith("cron:")) {
    const parts = args.split(/\s+/);
    const jobId = parts[0].slice(5); // remove "cron:"
    let lastN = 5;
    const lastIdx = parts.indexOf("--last");
    if (lastIdx !== -1 && parts[lastIdx + 1]) {
      lastN = parseInt(parts[lastIdx + 1], 10) || 5;
    }
    return formatCronReport(jobId, lastN);
  }

  // /cost top [N]
  if (args.startsWith("top")) {
    const parts = args.split(/\s+/);
    const limit = parseInt(parts[1], 10) || 10;
    return formatTopSessions("today", limit);
  }

  // /cost <period>
  const validPeriods = ["today", "24h", "week", "month"];
  const period = validPeriods.includes(args) ? args : "today";
  return formatCostReport(period);
}

export default plugin;
