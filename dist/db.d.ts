export declare function getDb(): any;
export declare function closeDb(): void;
export interface UsageRecord {
    timestamp: number;
    sessionKey: string;
    agentId: string;
    source: string;
    jobId: string | null;
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    durationMs: number;
    contextTokens?: number;
    toolName?: string;
    toolParamsHash?: string;
}
export declare function insertUsage(record: UsageRecord): void;
export interface CostSummary {
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    invocationCount: number;
}
export declare function getCostSince(sinceMs: number): CostSummary;
export declare function getCostByModel(sinceMs: number): Array<{
    model: string;
} & CostSummary>;
export declare function getCostBySource(sinceMs: number): Array<{
    source: string;
    job_id: string | null;
} & CostSummary>;
export declare function getCostBySession(sinceMs: number, limit?: number): Array<{
    session_key: string;
} & CostSummary>;
export declare function getSessionTurns(sessionKey: string): Array<{
    timestamp: number;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cost_usd: number;
    duration_ms: number;
    context_tokens: number;
    tool_name: string;
}>;
export declare function getRecentToolCalls(sessionKey: string, windowSize: number): Array<{
    tool_name: string;
    tool_params_hash: string;
}>;
export declare function getCronRunHistory(jobId: string, limit?: number): Array<{
    session_key: string;
    runCount: number;
    totalCost: number;
    totalTokens: number;
    firstTs: number;
    lastTs: number;
}>;
export declare function getDailyTotals(days?: number): Array<{
    date: string;
    totalCost: number;
    totalTokens: number;
}>;
export declare function getCostSinceForScope(sinceMs: number, scopeFilter: {
    agentId?: string;
    jobId?: string;
}): CostSummary;
export declare function getCronRunContextStats(jobId: string, limit?: number): Array<{
    session_key: string;
    runCount: number;
    totalCost: number;
    totalTokens: number;
    firstTs: number;
    lastTs: number;
    minContext: number;
    maxContext: number;
}>;
export declare function getCostInWindow(sinceMs: number, untilMs: number): number;
