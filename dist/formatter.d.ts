/** /cost [today|24h|week|month] */
export declare function formatCostReport(period?: string): string;
/** /cost session:<key> [--compact] — turn-by-turn autopsy with context analysis */
export declare function formatSessionReport(sessionKey: string, compact?: boolean): string;
/** /cost cron:<jobId> [--last N] — cron run comparison with context stats */
export declare function formatCronReport(jobId: string, lastN?: number): string;
/** /cost top [N] — top sessions by cost */
export declare function formatTopSessions(period?: string, limit?: number): string;
