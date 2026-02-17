import {
  getCostSince, getCostByModel, getCostBySource, getCostBySession,
  getSessionTurns, getCronRunHistory, getCronRunContextStats, type CostSummary,
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
    case "today": { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
    case "week": return now - 7 * 24 * 60 * 60 * 1000;
    case "month": { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); }
    case "24h":
    default: return now - 24 * 60 * 60 * 1000;
  }
}

/** /cost [today|24h|week|month] */
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
    for (const row of byModel) lines.push(`  ${row.model}: ${formatUsd(row.totalCost)} (${row.invocationCount} calls)`);
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

// --- PRD-04: Bloat detection constants ---
const BLOAT_GROWTH_PERCENT = 100;
const BLOAT_ABSOLUTE_MIN = 50_000;
const SHOW_DELTA_PERCENT = 50;

interface TurnDiag {
  index: number;
  deltaPercent: number;
  absDelta: number;
  isBloat: boolean;
  tool: string;
}

function generateDiagnostics(diags: TurnDiag[], lastCtx: number): string[] {
  const suggestions: string[] = [];
  for (const d of diags) {
    if (d.absDelta > 100_000 && ["Write", "bash", "readFile"].includes(d.tool)) {
      suggestions.push(`Turn ${d.index}: context jumped +${formatTokens(d.absDelta)} tokens. Likely cause: large tool output persisted to session.`);
    } else if (d.absDelta > 100_000 && d.tool === "web_search") {
      suggestions.push(`Turn ${d.index}: context jumped +${formatTokens(d.absDelta)} tokens. Likely cause: web search result expanded context.`);
    }
  }
  // Consecutive growth check
  let streak = 0;
  for (const d of diags) { streak = d.deltaPercent > 0 ? streak + 1 : 0; }
  if (streak >= 3) suggestions.push("Context compounding detected — consider /compact");
  if (lastCtx > 200_000) suggestions.push("Session approaching context limit");
  return suggestions;
}

/** /cost session:<key> [--compact] — turn-by-turn autopsy with context analysis */
export function formatSessionReport(sessionKey: string, compact?: boolean): string {
  const turns = getSessionTurns(sessionKey);
  if (turns.length === 0) return `No data for session: ${sessionKey}`;

  const hasContext = turns.some(t => t.context_tokens > 0);
  const hasTool = turns.some(t => t.tool_name !== '');

  // Compute per-turn diagnostics
  const diags: TurnDiag[] = [];
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1].context_tokens;
    const cur = turns[i].context_tokens;
    if (!hasContext || prev === 0) continue;
    const absDelta = cur - prev;
    const deltaPercent = (absDelta / prev) * 100;
    const isBloat = deltaPercent >= BLOAT_GROWTH_PERCENT && absDelta >= BLOAT_ABSOLUTE_MIN;
    diags.push({ index: i + 1, deltaPercent, absDelta, isBloat, tool: turns[i].tool_name });
  }

  const lines: string[] = [];
  lines.push(`Session: ${sessionKey}`);
  lines.push("");

  // Header
  let header = "  #   Time      Cost    ";
  if (hasContext) header += "  Ctx     ";
  header += "  Model";
  if (hasTool) header += "                     Tool";
  if (hasContext) header += "           Δ Context";
  lines.push(header);

  let cumCost = 0;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    cumCost += t.cost_usd;
    const ts = new Date(t.timestamp).toLocaleTimeString("en-US", { hour12: false });
    const diag = diags.find(d => d.index === i + 1);

    if (compact && !(diag?.isBloat)) continue;

    let line = `  ${String(i + 1).padStart(2)}  ${ts}  ${formatUsd(t.cost_usd)}`;
    if (hasContext) line += `  ${formatTokens(t.context_tokens).padStart(6)}`;
    line += `  ${t.model}`;
    if (hasTool) line += `  ${(t.tool_name || '').padEnd(15)}`;
    if (diag && hasContext) {
      const pct = `+${diag.deltaPercent.toFixed(0)}%`;
      line += ` ${pct}`;
      if (diag.isBloat) line += " ⚠ BLOAT";
    }
    lines.push(line);
  }

  // Summary
  lines.push("");
  lines.push(`Total: ${formatUsd(cumCost)} across ${turns.length} turns`);
  if (hasContext) {
    const first = turns[0].context_tokens;
    const last = turns[turns.length - 1].context_tokens;
    const growth = first > 0 ? (last / first).toFixed(1) : "N/A";
    lines.push(`Context: ${formatTokens(first)} → ${formatTokens(last)} (${growth}× growth)`);
  }

  // Diagnostics
  if (hasContext) {
    const suggestions = generateDiagnostics(diags, turns[turns.length - 1].context_tokens);
    if (suggestions.length > 0) {
      lines.push("");
      for (const s of suggestions) lines.push(`⚠ ${s}`);
    } else if (compact) {
      lines.push("No anomalies detected");
    }
  }

  return lines.join("\n");
}

/** /cost cron:<jobId> [--last N] — cron run comparison with context stats */
export function formatCronReport(jobId: string, lastN: number = 5): string {
  const stats = getCronRunContextStats(jobId, lastN);
  if (stats.length === 0) return `No data for cron job: ${jobId}`;

  const hasContext = stats.some(r => r.maxContext > 0);
  const lines: string[] = [];
  lines.push(`Cron Job — ${jobId} (last ${stats.length} runs)`);
  lines.push("");

  for (const r of stats) {
    const start = new Date(r.firstTs).toLocaleString();
    let line = `  ${start}  ${r.runCount} calls  ${formatUsd(r.totalCost)}  ${formatTokens(r.totalTokens)} tokens`;
    if (hasContext) {
      const growth = r.minContext > 0 ? (r.maxContext / r.minContext).toFixed(1) : "N/A";
      line += `  ${formatTokens(r.maxContext)} peak ctx  ${growth}× growth`;
    }
    lines.push(line);
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
