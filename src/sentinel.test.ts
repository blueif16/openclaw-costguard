import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkAfterEvent, sendAlert, type SentinelConfig, type SentinelAlert } from "./sentinel.js";
import type { UsageRecord } from "./db.js";

// Mock db module
vi.mock("./db.js", () => ({
  getRecentToolCalls: vi.fn(() => []),
  getSessionTurns: vi.fn(() => []),
  getCostSince: vi.fn(() => ({ totalCost: 0 })),
  getCostInWindow: vi.fn(() => 0),
  getCronRunHistory: vi.fn(() => []),
}));

import { getRecentToolCalls, getSessionTurns, getCostInWindow, getCronRunHistory } from "./db.js";

const base: UsageRecord = {
  timestamp: Date.now(), sessionKey: "s1", agentId: "a1", source: "user", jobId: null,
  model: "gpt-4", provider: "openai", inputTokens: 100, outputTokens: 50,
  cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, durationMs: 500,
  contextTokens: 10000, toolName: "bash", toolParamsHash: "abc123",
};

beforeEach(() => { vi.clearAllMocks(); });

describe("loopDetection", () => {
  const cfg: SentinelConfig = { loopDetection: { windowSize: 5, repeatThreshold: 3, action: "warn" } };

  it("triggers when same tool+hash repeated >= threshold", () => {
    vi.mocked(getRecentToolCalls).mockReturnValue([
      { tool_name: "bash", tool_params_hash: "abc123" },
      { tool_name: "bash", tool_params_hash: "abc123" },
      { tool_name: "bash", tool_params_hash: "abc123" },
      { tool_name: "readFile", tool_params_hash: "xyz" },
    ]);
    const alerts = checkAfterEvent(base, cfg);
    expect(alerts.length).toBe(1);
    expect(alerts[0].detector).toBe("loop");
  });

  it("no alert when below threshold", () => {
    vi.mocked(getRecentToolCalls).mockReturnValue([
      { tool_name: "bash", tool_params_hash: "abc123" },
      { tool_name: "bash", tool_params_hash: "abc123" },
      { tool_name: "readFile", tool_params_hash: "xyz" },
    ]);
    const alerts = checkAfterEvent(base, cfg);
    expect(alerts.length).toBe(0);
  });

  it("skipped when toolName is empty", () => {
    vi.mocked(getRecentToolCalls).mockReturnValue([]);
    const alerts = checkAfterEvent({ ...base, toolName: "" }, cfg);
    expect(alerts.length).toBe(0);
    expect(getRecentToolCalls).not.toHaveBeenCalled();
  });
});

describe("contextSpike", () => {
  const cfg: SentinelConfig = { contextSpike: { growthPercent: 150, absoluteMin: 50000, action: "warn" } };

  it("triggers on large context jump", () => {
    vi.mocked(getSessionTurns).mockReturnValue([
      { timestamp: 1, model: "m", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, duration_ms: 0, context_tokens: 40000, tool_name: "" },
      { timestamp: 2, model: "m", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, duration_ms: 0, context_tokens: 150000, tool_name: "" },
    ] as any);
    const alerts = checkAfterEvent({ ...base, contextTokens: 150000 }, cfg);
    expect(alerts.length).toBe(1);
    expect(alerts[0].detector).toBe("contextSpike");
  });

  it("no alert when growth below threshold", () => {
    vi.mocked(getSessionTurns).mockReturnValue([
      { timestamp: 1, model: "m", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, duration_ms: 0, context_tokens: 100000, tool_name: "" },
      { timestamp: 2, model: "m", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, duration_ms: 0, context_tokens: 120000, tool_name: "" },
    ] as any);
    const alerts = checkAfterEvent({ ...base, contextTokens: 120000 }, cfg);
    expect(alerts.length).toBe(0);
  });
});

describe("costVelocity", () => {
  const cfg: SentinelConfig = { costVelocity: { windowMinutes: 5, multiplier: 3, action: "warn" } };

  it("triggers when recent rate exceeds multiplier × 24h avg", () => {
    vi.mocked(getCostInWindow).mockImplementation((since: number, until: number) => {
      const span = until - since;
      if (span < 600_000) return 0.50; // 5min window: $0.50 → $0.10/min
      return 14.4; // 24h: $14.4 → $0.01/min
    });
    const alerts = checkAfterEvent(base, cfg);
    expect(alerts.length).toBe(1);
    expect(alerts[0].detector).toBe("costVelocity");
  });

  it("no alert when rate is normal", () => {
    vi.mocked(getCostInWindow).mockImplementation((since: number, until: number) => {
      const span = until - since;
      if (span < 600_000) return 0.05; // 5min: $0.01/min
      return 14.4; // 24h: $0.01/min
    });
    const alerts = checkAfterEvent(base, cfg);
    expect(alerts.length).toBe(0);
  });
});

describe("heartbeatDrift", () => {
  const cfg: SentinelConfig = { heartbeatDrift: { lookbackRuns: 5, driftPercent: 50, action: "warn" } };
  const cronRecord = { ...base, source: "cron", jobId: "daily-digest" };

  it("triggers when latest run cost drifts from avg", () => {
    vi.mocked(getCronRunHistory).mockReturnValue([
      { session_key: "s1", runCount: 5, totalCost: 0.30, totalTokens: 1000, firstTs: 1, lastTs: 2 },
      { session_key: "s2", runCount: 5, totalCost: 0.10, totalTokens: 1000, firstTs: 1, lastTs: 2 },
      { session_key: "s3", runCount: 5, totalCost: 0.10, totalTokens: 1000, firstTs: 1, lastTs: 2 },
    ]);
    const alerts = checkAfterEvent(cronRecord, cfg);
    expect(alerts.length).toBe(1);
    expect(alerts[0].detector).toBe("heartbeatDrift");
  });

  it("skipped for non-cron sources", () => {
    const alerts = checkAfterEvent(base, cfg);
    expect(alerts.length).toBe(0);
    expect(getCronRunHistory).not.toHaveBeenCalled();
  });
});

describe("alert dedup", () => {
  const cfg: SentinelConfig = { loopDetection: { windowSize: 5, repeatThreshold: 2, action: "warn" } };
  const dedupRecord = { ...base, sessionKey: "dedup-unique-session" };

  it("same detector+session deduped within 5min", () => {
    vi.mocked(getRecentToolCalls).mockReturnValue([
      { tool_name: "bash", tool_params_hash: "abc" },
      { tool_name: "bash", tool_params_hash: "abc" },
    ]);
    const first = checkAfterEvent(dedupRecord, cfg);
    const second = checkAfterEvent(dedupRecord, cfg);
    expect(first.length).toBe(1);
    expect(second.length).toBe(0);
  });
});

describe("sendAlert", () => {
  it("sends to channel when available", () => {
    const ctx = { sendChannelMessage: vi.fn(), logger: { warn: vi.fn() } };
    const alert: SentinelAlert = { detector: "loop", severity: "warn", sessionKey: "s1", message: "test", action: "warn", data: {} };
    sendAlert(alert, "#ops", ctx);
    expect(ctx.sendChannelMessage).toHaveBeenCalledWith("#ops", expect.stringContaining("loop"));
    expect(ctx.logger.warn).not.toHaveBeenCalled();
  });

  it("falls back to logger when no channel", () => {
    const ctx = { logger: { warn: vi.fn() } };
    const alert: SentinelAlert = { detector: "loop", severity: "warn", sessionKey: "s1", message: "test", action: "warn", data: {} };
    sendAlert(alert, undefined, ctx);
    expect(ctx.logger.warn).toHaveBeenCalled();
  });
});
