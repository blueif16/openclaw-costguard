export type SourceType = "user" | "cron" | "subagent" | "acp" | "heartbeat";
export interface Attribution {
    source: SourceType;
    jobId: string | null;
}
/**
 * Parse a sessionKey to determine the source of the invocation.
 *
 * Session key patterns:
 *   "agent:main:main"                              → user
 *   "agent:main:cron:<jobId>"                      → cron (no run id)
 *   "agent:main:cron:<jobId>:run:<runId>"          → cron
 *   "agent:main:subagent:<uuid>"                   → subagent
 *   "agent:main:acp:..."                           → acp
 *   "agent:main:heartbeat" (hypothetical)          → heartbeat (unreliable — see note)
 *
 * Note: heartbeat sessions currently use the main session key.
 * There is no isHeartbeat field on diagnostic events, so heartbeat
 * detection is best-effort only. A core PR would be needed for reliable detection.
 */
export declare function parseSessionKey(sessionKey: string): Attribution;
