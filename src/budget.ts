import { getCostSince } from "./db.js";

export interface BudgetConfig {
  dailyLimitUsd?: number;
  monthlyLimitUsd?: number;
  action: "warn" | "block";
}

export interface BudgetCheck {
  exceeded: boolean;
  type?: "daily" | "monthly";
  currentSpend: number;
  limit: number;
  message: string;
}

export function checkBudget(config: BudgetConfig): BudgetCheck {
  // Daily check
  if (config.dailyLimitUsd != null) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const daily = getCostSince(startOfDay.getTime());

    if (daily.totalCost >= config.dailyLimitUsd) {
      return {
        exceeded: true,
        type: "daily",
        currentSpend: daily.totalCost,
        limit: config.dailyLimitUsd,
        message: `Daily budget exceeded: $${daily.totalCost.toFixed(2)} / $${config.dailyLimitUsd.toFixed(2)}`
      };
    }
  }

  // Monthly check
  if (config.monthlyLimitUsd != null) {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const monthly = getCostSince(startOfMonth.getTime());

    if (monthly.totalCost >= config.monthlyLimitUsd) {
      return {
        exceeded: true,
        type: "monthly",
        currentSpend: monthly.totalCost,
        limit: config.monthlyLimitUsd,
        message: `Monthly budget exceeded: $${monthly.totalCost.toFixed(2)} / $${config.monthlyLimitUsd.toFixed(2)}`
      };
    }
  }

  return { exceeded: false, currentSpend: 0, limit: 0, message: "" };
}
