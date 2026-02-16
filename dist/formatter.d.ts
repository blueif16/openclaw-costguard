/** /cost [today|24h|week|month] — period summary */
export declare function formatCostReport(period?: string): string;
/** /cost session:<key> — turn-by-turn autopsy */
export declare function formatSessionReport(sessionKey: string): string;
/** /cost cron:<jobId> [--last N] — cron run comparison */
export declare function formatCronReport(jobId: string, lastN?: number): string;
/** /cost top [N] — top sessions by cost */
export declare function formatTopSessions(period?: string, limit?: number): string;
