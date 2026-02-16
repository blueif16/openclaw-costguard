"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSessionKey = parseSessionKey;
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
function parseSessionKey(sessionKey) {
    // Heartbeat — best-effort, may not match in practice
    if (sessionKey.includes(":heartbeat")) {
        return { source: "heartbeat", jobId: null };
    }
    // Cron job — extract jobId
    const cronMatch = sessionKey.match(/:cron:([^:]+)/);
    if (cronMatch) {
        return { source: "cron", jobId: cronMatch[1] };
    }
    // Subagent
    if (sessionKey.includes(":subagent:")) {
        return { source: "subagent", jobId: null };
    }
    // ACP
    if (sessionKey.includes(":acp:")) {
        return { source: "acp", jobId: null };
    }
    return { source: "user", jobId: null };
}
