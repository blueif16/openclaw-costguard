export interface ScopeOverride {
    dailyLimitUsd?: number;
    weeklyLimitUsd?: number;
    monthlyLimitUsd?: number;
}
export interface BudgetConfig {
    dailyLimitUsd?: number;
    weeklyLimitUsd?: number;
    monthlyLimitUsd?: number;
    warnThreshold: number;
    throttleThreshold?: number;
    throttleFallbackModel?: string;
    action: "warn" | "block";
    scopes?: Record<string, ScopeOverride>;
}
export type BudgetLevel = "ok" | "warning" | "throttle" | "exceeded";
export interface BudgetCheck {
    level: BudgetLevel;
    type?: "daily" | "weekly" | "monthly";
    currentSpend: number;
    limit: number;
    percent: number;
    message: string;
    fallbackModel?: string;
}
/** Resolve effective limits: exact scope → wildcard → global */
export declare function resolveScope(sessionKey: string, jobId: string | null, config: BudgetConfig): {
    limits: ScopeOverride & Pick<BudgetConfig, 'dailyLimitUsd' | 'weeklyLimitUsd' | 'monthlyLimitUsd'>;
    scopeFilter: {
        agentId?: string;
        jobId?: string;
    };
};
export declare function checkBudget(config: BudgetConfig, sessionKey?: string, jobId?: string | null): BudgetCheck;
