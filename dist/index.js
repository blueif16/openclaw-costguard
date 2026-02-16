"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pricing_js_1 = require("./pricing.js");
const db_js_1 = require("./db.js");
const attribution_js_1 = require("./attribution.js");
const budget_js_1 = require("./budget.js");
const formatter_js_1 = require("./formatter.js");
let budgetConfig;
let lastBudgetCheck = { level: "ok", message: "" };
const plugin = {
    id: "costguard",
    name: "Cost Guard",
    description: "Cost tracking, budget enforcement, and usage attribution for OpenClaw agents",
    register(api) {
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
            async start(ctx) {
                ctx.logger?.info?.("costguard: starting");
                // Load pricing data from LiteLLM
                const pricingResult = await (0, pricing_js_1.refreshPricing)();
                ctx.logger?.info?.(`costguard: pricing loaded (${pricingResult.count} models from ${pricingResult.source})`);
                // Bridge: subscribe via globalThis Symbol to receive events from the loader's emitter
                const BRIDGE_KEY = Symbol.for("openclaw.diagnosticBridge");
                if (!globalThis[BRIDGE_KEY]) {
                    globalThis[BRIDGE_KEY] = new Set();
                }
                const bridgeSet = globalThis[BRIDGE_KEY];
                const handler = (evt) => {
                    // ctx.logger?.info?.(`costguard: bridge event type=${evt.type}`);
                    if (evt.type !== "model.usage")
                        return;
                    try {
                        const sessionKey = evt.sessionKey ?? "";
                        const { source, jobId } = (0, attribution_js_1.parseSessionKey)(sessionKey);
                        const model = evt.model ?? "unknown";
                        const usage = evt.usage ?? {};
                        const inTokens = usage.input ?? usage.promptTokens ?? 0;
                        const outTokens = usage.output ?? 0;
                        const cacheRead = usage.cacheRead ?? 0;
                        const cacheWrite = usage.cacheWrite ?? 0;
                        const estimated = (0, pricing_js_1.estimateCost)(model, inTokens, outTokens, cacheRead, cacheWrite);
                        const costUsd = evt.costUsd || estimated.cost;
                        if (estimated.matchedModel && estimated.matchedModel !== model) {
                            ctx.logger?.info?.(`costguard: ${model} → matched pricing: ${estimated.matchedModel}`);
                        }
                        (0, db_js_1.insertUsage)({
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
                        lastBudgetCheck = (0, budget_js_1.checkBudget)(budgetConfig);
                        if (lastBudgetCheck.level !== "ok") {
                            ctx.logger?.warn?.(`costguard: ${lastBudgetCheck.message}`);
                        }
                    }
                    catch (err) {
                        ctx.logger?.error?.("costguard: failed to record usage", err);
                    }
                };
                bridgeSet.add(handler);
                ctx._costguardUnsub = () => bridgeSet.delete(handler);
                ctx.logger?.info?.("costguard: listening for model.usage events via globalThis bridge");
            },
            async stop(ctx) {
                ctx._costguardUnsub?.();
                (0, db_js_1.closeDb)();
                ctx.logger?.info?.("costguard: stopped");
            },
        });
        // --- Hook: before_tool_call — budget enforcement ---
        if (budgetConfig.action === "block") {
            api.registerHook("before_tool_call", (_event, _ctx) => {
                const check = (0, budget_js_1.checkBudget)(budgetConfig);
                if (check.level === "exceeded") {
                    return { block: true, blockReason: check.message };
                }
            }, { name: "costguard:budget-block" });
        }
        // --- Hook: before_agent_start — budget warning injection ---
        api.registerHook("before_agent_start", (_event, _ctx) => {
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
            handler(ctx) {
                const args = (ctx.args ?? "").trim();
                return { text: routeCostCommand(args) };
            },
        });
        api.logger?.info?.("costguard: registered");
    },
};
function routeCostCommand(args) {
    if (!args)
        return (0, formatter_js_1.formatCostReport)("today");
    // /cost session:<key>
    if (args.startsWith("session:")) {
        return (0, formatter_js_1.formatSessionReport)(args.slice(8));
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
        return (0, formatter_js_1.formatCronReport)(jobId, lastN);
    }
    // /cost top [N]
    if (args.startsWith("top")) {
        const parts = args.split(/\s+/);
        const limit = parseInt(parts[1], 10) || 10;
        return (0, formatter_js_1.formatTopSessions)("today", limit);
    }
    // /cost <period>
    const validPeriods = ["today", "24h", "week", "month"];
    const period = validPeriods.includes(args) ? args : "today";
    return (0, formatter_js_1.formatCostReport)(period);
}
exports.default = plugin;
