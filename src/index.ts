import { estimateCost, refreshPricing } from "./pricing.js";
import { insertUsage, closeDb } from "./db.js";
import { parseSessionKey } from "./attribution.js";
import { checkBudget, type BudgetConfig } from "./budget.js";
import { formatCostReport, formatSessionReport, formatCronReport, formatTopSessions } from "./formatter.js";

interface PluginApi {
  pluginConfig?: Record<string, any>;
  logger?: { info?: (...a: any[]) => void; warn?: (...a: any[]) => void; error?: (...a: any[]) => void };
  registerService: (service: { id: string; start: (ctx: any) => Promise<void>; stop?: (ctx: any) => Promise<void> }) => void;
  registerCommand: (cmd: { name: string; description: string; acceptsArgs?: boolean; requireAuth?: boolean; handler: (ctx: any) => any }) => void;
  registerHook: (events: string | string[], handler: (...args: any[]) => any, opts?: { name: string; description?: string }) => void;
}

let budgetConfig: BudgetConfig;
let lastBudgetCheck: { level: string; message: string } = { level: "ok", message: "" };

const plugin = {
  id: "costguard",
  name: "Cost Guard",
  description: "Cost tracking, budget enforcement, and usage attribution for OpenClaw agents",

  register(api: PluginApi) {
    const cfg = api.pluginConfig ?? {};
    budgetConfig = {
      dailyLimitUsd: cfg.dailyLimitUsd,
      monthlyLimitUsd: cfg.monthlyLimitUsd,
      warnThreshold: cfg.warnThreshold ?? 0.8,
      action: cfg.budgetAction ?? "warn",
    };

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
            });

            lastBudgetCheck = checkBudget(budgetConfig);
            if (lastBudgetCheck.level !== "ok") {
              ctx.logger?.warn?.(`costguard: ${lastBudgetCheck.message}`);
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

    // --- Hook: before_tool_call — budget enforcement ---
    if (budgetConfig.action === "block") {
      api.registerHook("before_tool_call", (_event: any, _ctx: any) => {
        const check = checkBudget(budgetConfig);
        if (check.level === "exceeded") {
          return { block: true, blockReason: check.message };
        }
      }, { name: "costguard:budget-block" });
    }

    // --- Hook: before_agent_start — budget warning injection ---
    api.registerHook("before_agent_start", (_event: any, _ctx: any) => {
      if (lastBudgetCheck.level === "warning") {
        return { prependContext: `[CostGuard Warning] ${lastBudgetCheck.message}` };
      }
      if (lastBudgetCheck.level === "exceeded") {
        return { prependContext: `[CostGuard Alert] ${lastBudgetCheck.message}` };
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

  // /cost session:<key>
  if (args.startsWith("session:")) {
    return formatSessionReport(args.slice(8));
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
