"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = require("node:crypto");
const pricing_js_1 = require("./pricing.js");
const db_js_1 = require("./db.js");
const attribution_js_1 = require("./attribution.js");
const budget_js_1 = require("./budget.js");
const formatter_js_1 = require("./formatter.js");
const sentinel_js_1 = require("./sentinel.js");
let budgetConfig;
let sentinelConfig;
let lastBudgetCheck = { level: "ok", message: "" };
const plugin = {
    id: "costguard",
    name: "Cost Guard",
    description: "Cost tracking, budget enforcement, and usage attribution for OpenClaw agents",
    register(api) {
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
                        // PRD-01: extract context_tokens, tool_name, tool_params_hash
                        const contextTokens = evt.contextTokens ?? evt.context?.tokens ?? 0;
                        const toolName = evt.toolName ?? evt.tool?.name ?? '';
                        const rawParams = evt.toolParams ?? evt.tool?.params;
                        const toolParamsHash = rawParams
                            ? (0, node_crypto_1.createHash)("sha256").update(JSON.stringify(rawParams)).digest("hex").slice(0, 16)
                            : '';
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
                            contextTokens,
                            toolName,
                            toolParamsHash,
                        });
                        lastBudgetCheck = (0, budget_js_1.checkBudget)(budgetConfig, sessionKey, jobId);
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
                        const alerts = (0, sentinel_js_1.checkAfterEvent)(record, sentinelConfig);
                        for (const alert of alerts) {
                            (0, sentinel_js_1.sendAlert)(alert, sentinelConfig.alertChannel, ctx);
                            if (alert.action === "pause") {
                                ctx._costguardSessionBlocked ??= new Set();
                                ctx._costguardSessionBlocked.add(alert.sessionKey);
                            }
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
        // --- Hook: before_tool_call — budget enforcement (block + throttle) ---
        if (budgetConfig.action === "block") {
            api.registerHook("before_tool_call", (event, _ctx) => {
                const sk = event?.sessionKey ?? "";
                const jid = event?.jobId ?? null;
                const result = (0, budget_js_1.checkBudget)(budgetConfig, sk, jid);
                if (result.level === "exceeded") {
                    return { block: true, blockReason: result.message };
                }
                if (result.level === "throttle" && result.fallbackModel) {
                    return { rewriteModel: result.fallbackModel };
                }
            }, { name: "costguard:budget-block" });
        }
        // --- Hook: before_agent_start — budget warning injection ---
        api.registerHook("before_agent_start", (event, _ctx) => {
            const sk = event?.sessionKey ?? "";
            const jid = event?.jobId ?? null;
            const result = (0, budget_js_1.checkBudget)(budgetConfig, sk, jid);
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
    // /cost session:<key> [--compact]
    if (args.startsWith("session:")) {
        const parts = args.split(/\s+/);
        const key = parts[0].slice(8);
        const compact = parts.includes("--compact");
        return (0, formatter_js_1.formatSessionReport)(key, compact);
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
