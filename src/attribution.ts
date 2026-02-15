export interface Attribution {
  source: "user" | "cron" | "heartbeat" | "subagent";
  jobId: string | null;
}

/**
 * Parse a sessionKey to determine the source of the invocation.
 *
 * Session key patterns observed in OpenClaw:
 *   "agent:main"                                    → user (interactive)
 *   "agent:main:cron:<jobId>:run:<runId>"           → cron
 *   "agent:main:heartbeat"                          → heartbeat
 *   "agent:main:subagent:<name>:<id>"               → subagent
 *   "agent:<agentId>"                               → user (non-main agent)
 *   "agent:<agentId>:cron:<jobId>:run:<runId>"      → cron (non-main)
 */
export function parseSessionKey(sessionKey: string): Attribution {
  // Heartbeat
  if (sessionKey.includes(":heartbeat")) {
    return { source: "heartbeat", jobId: null };
  }

  // Cron job — extract jobId
  const cronMatch = sessionKey.match(/:cron:([^:]+):run:/);
  if (cronMatch) {
    return { source: "cron", jobId: cronMatch[1] };
  }

  // Subagent
  if (sessionKey.includes(":subagent:")) {
    return { source: "subagent", jobId: null };
  }

  // Default: interactive user session
  return { source: "user", jobId: null };
}
