"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveScope = resolveScope;
exports.checkBudget = checkBudget;
const db_js_1 = require("./db.js");
const PERIOD_LABELS = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };
function check(spend, limit, type, warnThreshold, throttleThreshold, fallbackModel) {
    const percent = limit > 0 ? spend / limit : 0;
    if (percent >= 1) {
        return { level: "exceeded", type, currentSpend: spend, limit, percent,
            message: `${PERIOD_LABELS[type]} budget exceeded: $${spend.toFixed(2)} / $${limit.toFixed(2)}` };
    }
    if (throttleThreshold != null && fallbackModel && percent >= throttleThreshold) {
        return { level: "throttle", type, currentSpend: spend, limit, percent, fallbackModel,
            message: `${PERIOD_LABELS[type]} budget ${(percent * 100).toFixed(0)}% — throttling to ${fallbackModel}` };
    }
    if (percent >= warnThreshold) {
        return { level: "warning", type, currentSpend: spend, limit, percent,
            message: `${PERIOD_LABELS[type]} budget ${(percent * 100).toFixed(0)}%: $${spend.toFixed(2)} / $${limit.toFixed(2)}` };
    }
    return null;
}
/** Resolve effective limits: exact scope → wildcard → global */
function resolveScope(sessionKey, jobId, config) {
    const scopes = config.scopes;
    if (!scopes)
        return { limits: config, scopeFilter: {} };
    // Try exact match: "cron:<jobId>" or "agent:<id>"
    const agentMatch = sessionKey.match(/^agent:([^:]+)/);
    const agentKey = agentMatch ? `agent:${agentMatch[1]}` : null;
    const cronKey = jobId ? `cron:${jobId}` : null;
    // Priority: exact cron > exact agent > wildcard cron > wildcard agent > global
    const candidates = [cronKey, agentKey].filter(Boolean);
    for (const key of candidates) {
        if (scopes[key]) {
            const scopeFilter = cronKey === key ? { jobId: jobId } : { agentId: agentMatch[1] };
            return { limits: { ...config, ...scopes[key] }, scopeFilter };
        }
    }
    // Wildcard: "cron:*" or "agent:*"
    if (cronKey && scopes["cron:*"])
        return { limits: { ...config, ...scopes["cron:*"] }, scopeFilter: { jobId: jobId } };
    if (agentKey && scopes["agent:*"])
        return { limits: { ...config, ...scopes["agent:*"] }, scopeFilter: { agentId: agentMatch[1] } };
    return { limits: config, scopeFilter: {} };
}
function checkBudget(config, sessionKey, jobId) {
    const warnThreshold = config.warnThreshold ?? 0.8;
    const throttleThreshold = config.throttleThreshold;
    const fallbackModel = config.throttleFallbackModel;
    const { limits, scopeFilter } = (sessionKey)
        ? resolveScope(sessionKey, jobId ?? null, config)
        : { limits: config, scopeFilter: {} };
    const hasScope = Object.keys(scopeFilter).length > 0;
    const getCost = (sinceMs) => hasScope
        ? (0, db_js_1.getCostSinceForScope)(sinceMs, scopeFilter)
        : (0, db_js_1.getCostSince)(sinceMs);
    // Daily
    if (limits.dailyLimitUsd != null) {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        const r = check(getCost(d.getTime()).totalCost, limits.dailyLimitUsd, "daily", warnThreshold, throttleThreshold, fallbackModel);
        if (r)
            return r;
    }
    // Weekly
    if (limits.weeklyLimitUsd != null) {
        const r = check(getCost(Date.now() - 7 * 86400000).totalCost, limits.weeklyLimitUsd, "weekly", warnThreshold, throttleThreshold, fallbackModel);
        if (r)
            return r;
    }
    // Monthly
    if (limits.monthlyLimitUsd != null) {
        const d = new Date();
        d.setDate(1);
        d.setHours(0, 0, 0, 0);
        const r = check(getCost(d.getTime()).totalCost, limits.monthlyLimitUsd, "monthly", warnThreshold, throttleThreshold, fallbackModel);
        if (r)
            return r;
    }
    return { level: "ok", currentSpend: 0, limit: 0, percent: 0, message: "" };
}
