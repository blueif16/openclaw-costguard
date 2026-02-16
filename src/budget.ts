import { getCostSince } from "./db.js";

export interface BudgetConfig {
  dailyLimitUsd?: number;
  monthlyLimitUsd?: number;
  warnThreshold: number; // 0-1, default 0.8
  action: "warn" | "block";
}

export type BudgetLevel = "ok" | "warning" | "exceeded";

export interface BudgetCheck {
  level: BudgetLevel;
  type?: "daily" | "monthly";
  currentSpend: number;
  limit: number;
  percent: number;
  message: string;
}

function check(spend: number, limit: number, type: "daily" | "monthly", warnThreshold: number): BudgetCheck | null {
  const percent = limit > 0 ? spend / limit : 0;
  if (percent >= 1) {
    return {
      level: "exceeded",
      type,
      currentSpend: spend,
      limit,
      percent,
      message: `${type === "daily" ? "Daily" : "Monthly"} budget exceeded: $${spend.toFixed(2)} / $${limit.toFixed(2)}`,
    };
  }
  if (percent >= warnThreshold) {
    return {
      level: "warning",
      type,
      currentSpend: spend,
      limit,
      percent,
      message: `${type === "daily" ? "Daily" : "Monthly"} budget ${(percent * 100).toFixed(0)}%: $${spend.toFixed(2)} / $${limit.toFixed(2)}`,
    };
  }
  return null;
}

export function checkBudget(config: BudgetConfig): BudgetCheck {
  const warnThreshold = config.warnThreshold ?? 0.8;

  if (config.dailyLimitUsd != null) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const daily = getCostSince(startOfDay.getTime());
    const result = check(daily.totalCost, config.dailyLimitUsd, "daily", warnThreshold);
    if (result) return result;
  }

  if (config.monthlyLimitUsd != null) {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const monthly = getCostSince(startOfMonth.getTime());
    const result = check(monthly.totalCost, config.monthlyLimitUsd, "monthly", warnThreshold);
    if (result) return result;
  }

  return { level: "ok", currentSpend: 0, limit: 0, percent: 0, message: "" };
}
