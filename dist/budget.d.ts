export interface BudgetConfig {
    dailyLimitUsd?: number;
    monthlyLimitUsd?: number;
    warnThreshold: number;
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
export declare function checkBudget(config: BudgetConfig): BudgetCheck;
