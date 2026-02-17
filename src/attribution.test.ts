import { describe, it, expect } from "vitest";
import { parseSessionKey } from "./attribution.js";

describe("parseSessionKey", () => {
  it("user session", () => {
    expect(parseSessionKey("agent:main:main")).toEqual({ source: "user", jobId: null });
  });

  it("cron without run id", () => {
    expect(parseSessionKey("agent:main:cron:daily-digest")).toEqual({ source: "cron", jobId: "daily-digest" });
  });

  it("cron with run id", () => {
    expect(parseSessionKey("agent:main:cron:daily-digest:run:abc123")).toEqual({ source: "cron", jobId: "daily-digest" });
  });

  it("subagent", () => {
    expect(parseSessionKey("agent:main:subagent:uuid-1234")).toEqual({ source: "subagent", jobId: null });
  });

  it("acp", () => {
    expect(parseSessionKey("agent:main:acp:something")).toEqual({ source: "acp", jobId: null });
  });

  it("heartbeat", () => {
    expect(parseSessionKey("agent:main:heartbeat")).toEqual({ source: "heartbeat", jobId: null });
  });

  it("unknown falls back to user", () => {
    expect(parseSessionKey("random-key")).toEqual({ source: "user", jobId: null });
  });
});
