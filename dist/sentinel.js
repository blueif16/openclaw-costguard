"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkAfterEvent = checkAfterEvent;
exports.sendAlert = sendAlert;
const db_js_1 = require("./db.js");
// --- Detectors ---
function detectLoop(record, cfg) {
    if (!record.toolName)
        return null;
    const calls = (0, db_js_1.getRecentToolCalls)(record.sessionKey, cfg.windowSize);
    const counts = new Map();
    for (const c of calls) {
        const key = `${c.tool_name}|${c.tool_params_hash}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of counts) {
        if (count >= cfg.repeatThreshold) {
            const [tool, hash] = key.split("|");
            return {
                detector: "loop", severity: "critical", sessionKey: record.sessionKey, action: cfg.action,
                message: `Loop detected: ${tool} called ${count}× with same params (hash: ${hash}) in last ${cfg.windowSize} calls`,
                data: { tool, hash, count, window: cfg.windowSize },
            };
        }
    }
    return null;
}
function detectContextSpike(record, cfg) {
    if (!record.contextTokens)
        return null;
    const turns = (0, db_js_1.getSessionTurns)(record.sessionKey);
    if (turns.length < 2)
        return null;
    const prev = turns[turns.length - 2].context_tokens;
    const cur = turns[turns.length - 1].context_tokens;
    if (prev === 0)
        return null;
    const absDelta = cur - prev;
    const growthPct = (absDelta / prev) * 100;
    if (growthPct >= cfg.growthPercent && absDelta >= cfg.absoluteMin) {
        return {
            detector: "contextSpike", severity: "warn", sessionKey: record.sessionKey, action: cfg.action,
            message: `Context spike: ${prev} → ${cur} (+${growthPct.toFixed(0)}%, +${absDelta} tokens)`,
            data: { prev, cur, growthPct, absDelta },
        };
    }
    return null;
}
function detectCostVelocity(record, cfg) {
    const now = record.timestamp;
    const windowMs = cfg.windowMinutes * 60_000;
    const recentCost = (0, db_js_1.getCostInWindow)(now - windowMs, now);
    const recentRate = recentCost / cfg.windowMinutes; // $/min
    const dayAgo = now - 86_400_000;
    const dayCost = (0, db_js_1.getCostInWindow)(dayAgo, now);
    const dayRate = dayCost / 1440; // $/min over 24h
    if (dayRate === 0)
        return null; // cold start — skip
    const ratio = recentRate / dayRate;
    if (ratio >= cfg.multiplier) {
        return {
            detector: "costVelocity", severity: "warn", sessionKey: record.sessionKey, action: cfg.action,
            message: `Cost velocity anomaly: $${recentRate.toFixed(4)}/min (${ratio.toFixed(1)}× the 24h avg of $${dayRate.toFixed(4)}/min)`,
            data: { recentRate, dayRate, ratio, windowMinutes: cfg.windowMinutes },
        };
    }
    return null;
}
function detectHeartbeatDrift(record, cfg) {
    if (record.source !== "cron" || !record.jobId)
        return null;
    const runs = (0, db_js_1.getCronRunHistory)(record.jobId, cfg.lookbackRuns);
    if (runs.length < 2)
        return null;
    const latest = runs[0].totalCost;
    const previous = runs.slice(1);
    const avgPrev = previous.reduce((s, r) => s + r.totalCost, 0) / previous.length;
    if (avgPrev === 0)
        return null;
    const ratio = latest / avgPrev;
    if (ratio >= 1 + cfg.driftPercent / 100) {
        return {
            detector: "heartbeatDrift", severity: "warn", sessionKey: record.sessionKey, action: cfg.action,
            message: `Heartbeat drift: latest run $${latest.toFixed(4)} is ${(ratio * 100).toFixed(0)}% of avg $${avgPrev.toFixed(4)} (${previous.length} prior runs)`,
            data: { latest, avgPrev, ratio, lookback: cfg.lookbackRuns },
        };
    }
    return null;
}
// --- Alert dedup ---
const alertDedup = new Map();
const DEDUP_TTL_MS = 5 * 60_000;
function isDuplicate(alert) {
    const key = `${alert.detector}|${alert.sessionKey}`;
    const last = alertDedup.get(key);
    const now = Date.now();
    if (last && now - last < DEDUP_TTL_MS)
        return true;
    alertDedup.set(key, now);
    return false;
}
// --- Main entry ---
function checkAfterEvent(record, config) {
    const alerts = [];
    if (config.loopDetection) {
        const a = detectLoop(record, config.loopDetection);
        if (a && !isDuplicate(a))
            alerts.push(a);
    }
    if (config.contextSpike) {
        const a = detectContextSpike(record, config.contextSpike);
        if (a && !isDuplicate(a))
            alerts.push(a);
    }
    if (config.costVelocity) {
        const a = detectCostVelocity(record, config.costVelocity);
        if (a && !isDuplicate(a))
            alerts.push(a);
    }
    if (config.heartbeatDrift) {
        const a = detectHeartbeatDrift(record, config.heartbeatDrift);
        if (a && !isDuplicate(a))
            alerts.push(a);
    }
    return alerts;
}
function sendAlert(alert, channel, ctx) {
    const text = `[CostGuard Sentinel] ${alert.detector}: ${alert.message}`;
    if (channel && typeof ctx.sendChannelMessage === "function") {
        ctx.sendChannelMessage(channel, text);
    }
    else {
        ctx.logger?.warn?.(text);
    }
}
