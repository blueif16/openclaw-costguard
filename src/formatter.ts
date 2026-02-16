import {
  getCostSince, getCostByModel, getCostBySource, getCostBySession,
  getSessionTurns, getCronRunHistory, type CostSummary,
} from "./db.js";

function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function timeRange(label: string): number {
  const now = Date.now();
  switch (label) {
    case "today": {
      const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
    }
    case "week": return now - 7 * 24 * 60 * 60 * 1000;
    case "month": {
      const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime();
    }
    case "24h":
    default: return now - 24 * 60 * 60 * 1000;
  }
}

/** /cost [today|24h|week|month] — period summary */
export function formatCostReport(period: string = "today"): string {
  const sinceMs = timeRange(period);
  const summary = getCostSince(sinceMs);
  const byModel = getCostByModel(sinceMs);
  const bySource = getCostBySource(sinceMs);

  const lines: string[] = [];
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
export function formatSessionReport(sessionKey: string): string {
  const turns = getSessionTurns(sessionKey);
  if (turns.length === 0) return `No data for session: ${sessionKey}`;

  const lines: string[] = [];
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
export function formatCronReport(jobId: string, lastN: number = 5): string {
  const runs = getCronRunHistory(jobId, lastN);
  if (runs.length === 0) return `No data for cron job: ${jobId}`;

  const lines: string[] = [];
  lines.push(`Cron Job — ${jobId} (last ${runs.length} runs)`);
  lines.push("");

  for (const r of runs) {
    const start = new Date(r.firstTs).toLocaleString();
    lines.push(`  ${start}  ${r.runCount} calls  ${formatUsd(r.totalCost)}  ${formatTokens(r.totalTokens)} tokens`);
  }

  return lines.join("\n");
}

/** /cost top [N] — top sessions by cost */
export function formatTopSessions(period: string = "today", limit: number = 10): string {
  const sinceMs = timeRange(period);
  const sessions = getCostBySession(sinceMs, limit);
  if (sessions.length === 0) return `No sessions found for period: ${period}`;

  const lines: string[] = [];
  lines.push(`Top ${sessions.length} Sessions — ${period}`);
  lines.push("");

  for (const s of sessions) {
    lines.push(`  ${s.session_key}: ${formatUsd(s.totalCost)} (${s.invocationCount} calls, ${formatTokens(s.totalInputTokens + s.totalOutputTokens)} tokens)`);
  }

  return lines.join("\n");
}
