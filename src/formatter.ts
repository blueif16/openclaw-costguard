import { getCostSince, getCostByModel, getCostBySource, type CostSummary } from "./db.js";

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
      const d = new Date(); d.setHours(0,0,0,0); return d.getTime();
    }
    case "week": return now - 7 * 24 * 60 * 60 * 1000;
    case "month": {
      const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d.getTime();
    }
    case "24h":
    default: return now - 24 * 60 * 60 * 1000;
  }
}

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
