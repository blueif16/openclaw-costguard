"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatCostReport = formatCostReport;
exports.formatSessionReport = formatSessionReport;
exports.formatCronReport = formatCronReport;
exports.formatTopSessions = formatTopSessions;
const db_js_1 = require("./db.js");
function formatUsd(n) {
    return `$${n.toFixed(4)}`;
}
function formatTokens(n) {
    if (n >= 1_000_000)
        return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)
        return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
}
function timeRange(label) {
    const now = Date.now();
    switch (label) {
        case "today": {
            const d = new Date();
            d.setHours(0, 0, 0, 0);
            return d.getTime();
        }
        case "week": return now - 7 * 24 * 60 * 60 * 1000;
        case "month": {
            const d = new Date();
            d.setDate(1);
            d.setHours(0, 0, 0, 0);
            return d.getTime();
        }
        case "24h":
        default: return now - 24 * 60 * 60 * 1000;
    }
}
/** /cost [today|24h|week|month] — period summary */
function formatCostReport(period = "today") {
    const sinceMs = timeRange(period);
    const summary = (0, db_js_1.getCostSince)(sinceMs);
    const byModel = (0, db_js_1.getCostByModel)(sinceMs);
    const bySource = (0, db_js_1.getCostBySource)(sinceMs);
    const lines = [];
    lines.push(`Cost Report — ${period}`);
    lines.push("");
    lines.push(`Total: ${formatUsd(summary.totalCost)} across ${summary.invocationCount} API calls`);
    lines.push(`Tokens: ${formatTokens(summary.totalInputTokens)} in / ${formatTokens(summary.totalOutputTokens)} out`);
    lines.push("");
    if (byModel.length > 0) {
        lines.push("By model:");
        for (const row of byModel) {
            lines.push(`  ${row.model}: ${formatUsd(row.totalCost)} (${row.invocationCount} calls)`);
        }
        lines.push("");
    }
    if (bySource.length > 0) {
        lines.push("By source:");
        for (const row of bySource) {
            const label = row.job_id ? `cron/${row.job_id}` : row.source;
            lines.push(`  ${label}: ${formatUsd(row.totalCost)} (${row.invocationCount} calls)`);
        }
    }
    return lines.join("\n");
}
/** /cost session:<key> — turn-by-turn autopsy */
function formatSessionReport(sessionKey) {
    const turns = (0, db_js_1.getSessionTurns)(sessionKey);
    if (turns.length === 0)
        return `No data for session: ${sessionKey}`;
    const lines = [];
    lines.push(`Session Autopsy — ${sessionKey}`);
    lines.push("");
    let cumCost = 0;
    for (const t of turns) {
        cumCost += t.cost_usd;
        const ts = new Date(t.timestamp).toLocaleTimeString();
        lines.push(`  ${ts}  ${t.model}  ${formatTokens(t.input_tokens)}in/${formatTokens(t.output_tokens)}out  ${formatUsd(t.cost_usd)}  (cum: ${formatUsd(cumCost)})  ${t.duration_ms}ms`);
    }
    lines.push("");
    lines.push(`Total: ${formatUsd(cumCost)} across ${turns.length} turns`);
    return lines.join("\n");
}
/** /cost cron:<jobId> [--last N] — cron run comparison */
function formatCronReport(jobId, lastN = 5) {
    const runs = (0, db_js_1.getCronRunHistory)(jobId, lastN);
    if (runs.length === 0)
        return `No data for cron job: ${jobId}`;
    const lines = [];
    lines.push(`Cron Job — ${jobId} (last ${runs.length} runs)`);
    lines.push("");
    for (const r of runs) {
        const start = new Date(r.firstTs).toLocaleString();
        lines.push(`  ${start}  ${r.runCount} calls  ${formatUsd(r.totalCost)}  ${formatTokens(r.totalTokens)} tokens`);
    }
    return lines.join("\n");
}
/** /cost top [N] — top sessions by cost */
function formatTopSessions(period = "today", limit = 10) {
    const sinceMs = timeRange(period);
    const sessions = (0, db_js_1.getCostBySession)(sinceMs, limit);
    if (sessions.length === 0)
        return `No sessions found for period: ${period}`;
    const lines = [];
    lines.push(`Top ${sessions.length} Sessions — ${period}`);
    lines.push("");
    for (const s of sessions) {
        lines.push(`  ${s.session_key}: ${formatUsd(s.totalCost)} (${s.invocationCount} calls, ${formatTokens(s.totalInputTokens + s.totalOutputTokens)} tokens)`);
    }
    return lines.join("\n");
}
