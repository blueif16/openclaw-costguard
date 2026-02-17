import { getRecentToolCalls, getSessionTurns, getCostSince, getCostInWindow, getCronRunHistory } from "./db.js";
import type { UsageRecord } from "./db.js";

// --- Config interfaces ---

export interface LoopConfig {
  windowSize: number;      // recent N calls
  repeatThreshold: number; // same tool+hash >= M
  action: "warn" | "pause";
}

export interface ContextSpikeConfig {
  growthPercent: number;   // e.g. 150
  absoluteMin: number;     // e.g. 50000
  action: "warn" | "pause";
}

export interface CostVelocityConfig {
  windowMinutes: number;   // e.g. 5
  multiplier: number;      // e.g. 3
  action: "warn" | "pause";
}

export interface HeartbeatDriftConfig {
  lookbackRuns: number;    // e.g. 10
  driftPercent: number;    // e.g. 50
  action: "warn" | "pause";
}

export interface SentinelConfig {
  loopDetection?: LoopConfig;
  contextSpike?: ContextSpikeConfig;
  costVelocity?: CostVelocityConfig;
  heartbeatDrift?: HeartbeatDriftConfig;
  alertChannel?: string;
}

export interface SentinelAlert {
  detector: string;
  severity: "warn" | "critical";
  sessionKey: string;
  message: string;
  action: "warn" | "pause";
  data: Record<string, any>;
}

// --- Detectors ---

function detectLoop(record: UsageRecord, cfg: LoopConfig): SentinelAlert | null {
  if (!record.toolName) return null;
  const calls = getRecentToolCalls(record.sessionKey, cfg.windowSize);
  const counts = new Map<string, number>();
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

function detectContextSpike(record: UsageRecord, cfg: ContextSpikeConfig): SentinelAlert | null {
  if (!record.contextTokens) return null;
  const turns = getSessionTurns(record.sessionKey);
  if (turns.length < 2) return null;
  const prev = turns[turns.length - 2].context_tokens;
  const cur = turns[turns.length - 1].context_tokens;
  if (prev === 0) return null;
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

function detectCostVelocity(record: UsageRecord, cfg: CostVelocityConfig): SentinelAlert | null {
  const now = record.timestamp;
  const windowMs = cfg.windowMinutes * 60_000;
  const recentCost = getCostInWindow(now - windowMs, now);
  const recentRate = recentCost / cfg.windowMinutes; // $/min

  const dayAgo = now - 86_400_000;
  const dayCost = getCostInWindow(dayAgo, now);
  const dayRate = dayCost / 1440; // $/min over 24h
  if (dayRate === 0) return null; // cold start — skip

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

function detectHeartbeatDrift(record: UsageRecord, cfg: HeartbeatDriftConfig): SentinelAlert | null {
  if (record.source !== "cron" || !record.jobId) return null;
  const runs = getCronRunHistory(record.jobId, cfg.lookbackRuns);
  if (runs.length < 2) return null;

  const latest = runs[0].totalCost;
  const previous = runs.slice(1);
  const avgPrev = previous.reduce((s, r) => s + r.totalCost, 0) / previous.length;
  if (avgPrev === 0) return null;

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
const alertDedup = new Map<string, number>();
const DEDUP_TTL_MS = 5 * 60_000;

function isDuplicate(alert: SentinelAlert): boolean {
  const key = `${alert.detector}|${alert.sessionKey}`;
  const last = alertDedup.get(key);
  const now = Date.now();
  if (last && now - last < DEDUP_TTL_MS) return true;
  alertDedup.set(key, now);
  return false;
}

// --- Main entry ---

export function checkAfterEvent(record: UsageRecord, config: SentinelConfig): SentinelAlert[] {
  const alerts: SentinelAlert[] = [];
  if (config.loopDetection) { const a = detectLoop(record, config.loopDetection); if (a && !isDuplicate(a)) alerts.push(a); }
  if (config.contextSpike) { const a = detectContextSpike(record, config.contextSpike); if (a && !isDuplicate(a)) alerts.push(a); }
  if (config.costVelocity) { const a = detectCostVelocity(record, config.costVelocity); if (a && !isDuplicate(a)) alerts.push(a); }
  if (config.heartbeatDrift) { const a = detectHeartbeatDrift(record, config.heartbeatDrift); if (a && !isDuplicate(a)) alerts.push(a); }
  return alerts;
}

export function sendAlert(alert: SentinelAlert, channel: string | undefined, ctx: any): void {
  const text = `[CostGuard Sentinel] ${alert.detector}: ${alert.message}`;
  if (channel && typeof ctx.sendChannelMessage === "function") {
    ctx.sendChannelMessage(channel, text);
  } else {
    ctx.logger?.warn?.(text);
  }
}
