import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveScope, checkBudget, type BudgetConfig } from "./budget.js";

// Mock db module
vi.mock("./db.js", () => ({
  getCostSince: vi.fn(() => ({ totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, invocationCount: 0 })),
  getCostSinceForScope: vi.fn(() => ({ totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, invocationCount: 0 })),
}));

import { getCostSince, getCostSinceForScope } from "./db.js";
const mockGetCostSince = vi.mocked(getCostSince);
const mockGetCostSinceForScope = vi.mocked(getCostSinceForScope);

const cost = (totalCost: number) => ({ totalCost, totalInputTokens: 0, totalOutputTokens: 0, invocationCount: 1 });

beforeEach(() => { vi.clearAllMocks(); });

describe("resolveScope", () => {
  const base: BudgetConfig = { dailyLimitUsd: 10, monthlyLimitUsd: 200, warnThreshold: 0.8, action: "warn" };

  it("no scopes → global limits", () => {
    const { limits, scopeFilter } = resolveScope("agent:main:main", null, base);
    expect(limits.dailyLimitUsd).toBe(10);
    expect(scopeFilter).toEqual({});
  });

  it("exact cron scope match", () => {
    const cfg = { ...base, scopes: { "cron:daily-digest": { dailyLimitUsd: 1 } } };
    const { limits, scopeFilter } = resolveScope("agent:main:cron:daily-digest", "daily-digest", cfg);
    expect(limits.dailyLimitUsd).toBe(1);
    expect(limits.monthlyLimitUsd).toBe(200); // inherited
    expect(scopeFilter).toEqual({ jobId: "daily-digest" });
  });

  it("exact agent scope match", () => {
    const cfg = { ...base, scopes: { "agent:work": { dailyLimitUsd: 5 } } };
    const { limits, scopeFilter } = resolveScope("agent:work:main", null, cfg);
    expect(limits.dailyLimitUsd).toBe(5);
    expect(scopeFilter).toEqual({ agentId: "work" });
  });

  it("wildcard cron:* fallback", () => {
    const cfg = { ...base, scopes: { "cron:*": { dailyLimitUsd: 3 } } };
    const { limits, scopeFilter } = resolveScope("agent:main:cron:unknown-job", "unknown-job", cfg);
    expect(limits.dailyLimitUsd).toBe(3);
    expect(scopeFilter).toEqual({ jobId: "unknown-job" });
  });

  it("exact scope wins over wildcard", () => {
    const cfg = { ...base, scopes: { "cron:special": { dailyLimitUsd: 1 }, "cron:*": { dailyLimitUsd: 5 } } };
    const { limits } = resolveScope("agent:main:cron:special", "special", cfg);
    expect(limits.dailyLimitUsd).toBe(1);
  });

  it("no matching scope → global fallback", () => {
    const cfg = { ...base, scopes: { "agent:work": { dailyLimitUsd: 5 } } };
    const { limits, scopeFilter } = resolveScope("agent:main:main", null, cfg);
    expect(limits.dailyLimitUsd).toBe(10);
    expect(scopeFilter).toEqual({});
  });
});

describe("checkBudget", () => {
  const base: BudgetConfig = { dailyLimitUsd: 10, warnThreshold: 0.8, action: "warn" };

  it("ok when under threshold", () => {
    mockGetCostSince.mockReturnValue(cost(5));
    expect(checkBudget(base).level).toBe("ok");
  });

  it("warning at warnThreshold", () => {
    mockGetCostSince.mockReturnValue(cost(8.5));
    const r = checkBudget(base);
    expect(r.level).toBe("warning");
    expect(r.type).toBe("daily");
  });

  it("exceeded at limit", () => {
    mockGetCostSince.mockReturnValue(cost(10.5));
    const r = checkBudget(base);
    expect(r.level).toBe("exceeded");
  });

  it("throttle between throttleThreshold and limit", () => {
    const cfg: BudgetConfig = { ...base, throttleThreshold: 0.9, throttleFallbackModel: "anthropic/claude-haiku-4" };
    mockGetCostSince.mockReturnValue(cost(9.2));
    const r = checkBudget(cfg);
    expect(r.level).toBe("throttle");
    expect(r.fallbackModel).toBe("anthropic/claude-haiku-4");
  });

  it("weekly check triggers", () => {
    const cfg: BudgetConfig = { ...base, dailyLimitUsd: undefined, weeklyLimitUsd: 50, warnThreshold: 0.8 };
    mockGetCostSince.mockReturnValue(cost(45));
    const r = checkBudget(cfg);
    expect(r.level).toBe("warning");
    expect(r.type).toBe("weekly");
  });

  it("monthly check triggers", () => {
    const cfg: BudgetConfig = { ...base, dailyLimitUsd: undefined, monthlyLimitUsd: 200, warnThreshold: 0.8 };
    mockGetCostSince.mockReturnValue(cost(201));
    const r = checkBudget(cfg);
    expect(r.level).toBe("exceeded");
    expect(r.type).toBe("monthly");
  });

  it("daily checked before weekly", () => {
    const cfg: BudgetConfig = { ...base, dailyLimitUsd: 10, weeklyLimitUsd: 100, warnThreshold: 0.8 };
    mockGetCostSince.mockReturnValue(cost(9)); // 90% of daily
    const r = checkBudget(cfg);
    expect(r.level).toBe("warning");
    expect(r.type).toBe("daily");
  });

  it("scope-filtered query used when sessionKey provided", () => {
    const cfg: BudgetConfig = { ...base, scopes: { "cron:test": { dailyLimitUsd: 1 } } };
    mockGetCostSinceForScope.mockReturnValue(cost(0.5));
    const r = checkBudget(cfg, "agent:main:cron:test", "test");
    expect(r.level).toBe("ok");
    expect(mockGetCostSinceForScope).toHaveBeenCalled();
    expect(mockGetCostSince).not.toHaveBeenCalled();
  });
});
