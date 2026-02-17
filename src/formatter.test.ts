import { describe, it, expect, vi } from "vitest";
import { formatCostReport, formatSessionReport, formatCronReport, formatTopSessions } from "./formatter.js";

vi.mock("./db.js", () => ({
  getCostSince: vi.fn(() => ({ totalCost: 1.2345, totalInputTokens: 50000, totalOutputTokens: 10000, invocationCount: 5 })),
  getCostByModel: vi.fn(() => [{ model: "gpt-4", totalCost: 1.0, invocationCount: 3 }]),
  getCostBySource: vi.fn(() => [{ source: "user", job_id: null, totalCost: 1.2, invocationCount: 5 }]),
  getCostBySession: vi.fn(() => [{ session_key: "s1", totalCost: 1.0, invocationCount: 3, totalInputTokens: 40000, totalOutputTokens: 8000 }]),
  getSessionTurns: vi.fn(() => []),
  getCronRunContextStats: vi.fn(() => []),
}));

import { getSessionTurns, getCronRunContextStats } from "./db.js";

describe("formatCostReport", () => {
  it("includes total cost and token counts", () => {
    const out = formatCostReport("today");
    expect(out).toContain("$1.2345");
    expect(out).toContain("5 API calls");
    expect(out).toContain("50.0K in");
  });

  it("includes by-model breakdown", () => {
    const out = formatCostReport("today");
    expect(out).toContain("gpt-4");
    expect(out).toContain("$1.0000");
  });
});

describe("formatSessionReport", () => {
  it("returns no-data message for empty session", () => {
    vi.mocked(getSessionTurns).mockReturnValue([]);
    expect(formatSessionReport("unknown")).toContain("No data");
  });

  it("renders turn table with context and tool columns", () => {
    vi.mocked(getSessionTurns).mockReturnValue([
      { timestamp: Date.now() - 60000, model: "gpt-4", input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0, cost_usd: 0.05, duration_ms: 300, context_tokens: 10000, tool_name: "bash" },
      { timestamp: Date.now(), model: "gpt-4", input_tokens: 2000, output_tokens: 400, cache_read_tokens: 0, cost_usd: 0.10, duration_ms: 500, context_tokens: 80000, tool_name: "Write" },
    ] as any);
    const out = formatSessionReport("s1");
    expect(out).toContain("Session: s1");
    expect(out).toContain("Ctx");
    expect(out).toContain("Tool");
    expect(out).toContain("gpt-4");
  });

  it("marks BLOAT on large context jump", () => {
    vi.mocked(getSessionTurns).mockReturnValue([
      { timestamp: 1, model: "m", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, duration_ms: 0, context_tokens: 30000, tool_name: "bash" },
      { timestamp: 2, model: "m", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, duration_ms: 0, context_tokens: 150000, tool_name: "Write" },
    ] as any);
    const out = formatSessionReport("s1");
    expect(out).toContain("BLOAT");
  });

  it("--compact only shows BLOAT turns", () => {
    vi.mocked(getSessionTurns).mockReturnValue([
      { timestamp: 1, model: "m", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, duration_ms: 0, context_tokens: 30000, tool_name: "bash" },
      { timestamp: 2, model: "m", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, duration_ms: 0, context_tokens: 35000, tool_name: "readFile" },
      { timestamp: 3, model: "m", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, duration_ms: 0, context_tokens: 150000, tool_name: "Write" },
    ] as any);
    const out = formatSessionReport("s1", true);
    expect(out).toContain("BLOAT");
    expect(out).not.toContain("readFile"); // non-bloat turn hidden
  });

  it("shows diagnostic suggestions", () => {
    vi.mocked(getSessionTurns).mockReturnValue([
      { timestamp: 1, model: "m", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, duration_ms: 0, context_tokens: 30000, tool_name: "bash" },
      { timestamp: 2, model: "m", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, duration_ms: 0, context_tokens: 180000, tool_name: "bash" },
    ] as any);
    const out = formatSessionReport("s1");
    expect(out).toContain("large tool output");
  });
});

describe("formatCronReport", () => {
  it("returns no-data message for unknown job", () => {
    vi.mocked(getCronRunContextStats).mockReturnValue([]);
    expect(formatCronReport("unknown")).toContain("No data");
  });

  it("shows peak ctx and growth", () => {
    vi.mocked(getCronRunContextStats).mockReturnValue([
      { session_key: "s1", runCount: 3, totalCost: 0.15, totalTokens: 5000, firstTs: Date.now() - 3600000, lastTs: Date.now(), minContext: 10000, maxContext: 80000 },
    ] as any);
    const out = formatCronReport("daily-digest", 5);
    expect(out).toContain("daily-digest");
    expect(out).toContain("80.0K");
    expect(out).toContain("peak ctx");
    expect(out).toContain("growth");
  });
});

describe("formatTopSessions", () => {
  it("lists sessions by cost", () => {
    const out = formatTopSessions("today", 10);
    expect(out).toContain("s1");
    expect(out).toContain("$1.0000");
  });
});
