import path from "node:path";
import os from "node:os";

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
const DB_PATH = path.join(OPENCLAW_HOME, "costguard.db");

let db: any;
let DatabaseSync: any;

export function getDb(): any {
  if (!db) {
    // Lazy require: node:sqlite must not be loaded at module-parse time
    // because the gateway uses jiti which can break native node: imports.
    if (!DatabaseSync) {
      DatabaseSync = require("node:sqlite").DatabaseSync;
    }
    db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    initSchema();
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function initSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      session_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      source TEXT NOT NULL,
      job_id TEXT,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cost_usd REAL NOT NULL,
      duration_ms INTEGER DEFAULT 0,
      context_tokens INTEGER DEFAULT 0,
      tool_name TEXT DEFAULT '',
      tool_params_hash TEXT DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_source ON usage(source);
    CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(model);
    CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_key);
    CREATE INDEX IF NOT EXISTS idx_usage_job ON usage(job_id);
    CREATE INDEX IF NOT EXISTS idx_usage_tool ON usage(session_key, tool_name, tool_params_hash);
  `);

  // Migrate existing databases: add new columns if missing
  const cols = db.prepare("PRAGMA table_info(usage)").all().map((c: any) => c.name);
  if (!cols.includes("context_tokens")) db.exec("ALTER TABLE usage ADD COLUMN context_tokens INTEGER DEFAULT 0");
  if (!cols.includes("tool_name")) db.exec("ALTER TABLE usage ADD COLUMN tool_name TEXT DEFAULT ''");
  if (!cols.includes("tool_params_hash")) db.exec("ALTER TABLE usage ADD COLUMN tool_params_hash TEXT DEFAULT ''");
}

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

export function insertUsage(record: UsageRecord): void {
  const stmt = getDb().prepare(`
    INSERT INTO usage (timestamp, session_key, agent_id, source, job_id, model, provider,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms,
      context_tokens, tool_name, tool_params_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    record.timestamp, record.sessionKey, record.agentId, record.source,
    record.jobId, record.model, record.provider,
    record.inputTokens, record.outputTokens, record.cacheReadTokens,
    record.cacheWriteTokens, record.costUsd, record.durationMs,
    record.contextTokens ?? 0, record.toolName ?? '', record.toolParamsHash ?? ''
  );
}

// --- Query helpers ---

export interface CostSummary {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  invocationCount: number;
}

export function getCostSince(sinceMs: number): CostSummary {
  const row = getDb().prepare(`
    SELECT
      COALESCE(SUM(cost_usd), 0) as totalCost,
      COALESCE(SUM(input_tokens), 0) as totalInputTokens,
      COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
      COUNT(*) as invocationCount
    FROM usage WHERE timestamp >= ?
  `).get(sinceMs);
  return row ?? { totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, invocationCount: 0 };
}

export function getCostByModel(sinceMs: number): Array<{ model: string } & CostSummary> {
  return getDb().prepare(`
    SELECT model,
      COALESCE(SUM(cost_usd), 0) as totalCost,
      COALESCE(SUM(input_tokens), 0) as totalInputTokens,
      COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
      COUNT(*) as invocationCount
    FROM usage WHERE timestamp >= ?
    GROUP BY model ORDER BY totalCost DESC
  `).all(sinceMs);
}

export function getCostBySource(sinceMs: number): Array<{ source: string; job_id: string | null } & CostSummary> {
  return getDb().prepare(`
    SELECT source, job_id,
      COALESCE(SUM(cost_usd), 0) as totalCost,
      COALESCE(SUM(input_tokens), 0) as totalInputTokens,
      COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
      COUNT(*) as invocationCount
    FROM usage WHERE timestamp >= ?
    GROUP BY source, job_id ORDER BY totalCost DESC
  `).all(sinceMs);
}

export function getCostBySession(sinceMs: number, limit: number = 10): Array<{ session_key: string } & CostSummary> {
  return getDb().prepare(`
    SELECT session_key,
      COALESCE(SUM(cost_usd), 0) as totalCost,
      COALESCE(SUM(input_tokens), 0) as totalInputTokens,
      COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
      COUNT(*) as invocationCount
    FROM usage WHERE timestamp >= ?
    GROUP BY session_key ORDER BY totalCost DESC LIMIT ?
  `).all(sinceMs, limit);
}

export function getSessionTurns(sessionKey: string): Array<{
  timestamp: number; model: string; input_tokens: number; output_tokens: number;
  cache_read_tokens: number; cost_usd: number; duration_ms: number;
  context_tokens: number; tool_name: string;
}> {
  return getDb().prepare(`
    SELECT timestamp, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, duration_ms,
      context_tokens, tool_name
    FROM usage WHERE session_key = ? ORDER BY timestamp ASC
  `).all(sessionKey);
}

export function getRecentToolCalls(sessionKey: string, windowSize: number): Array<{
  tool_name: string; tool_params_hash: string;
}> {
  return getDb().prepare(`
    SELECT tool_name, tool_params_hash FROM usage
    WHERE session_key = ? AND tool_name != ''
    ORDER BY timestamp DESC LIMIT ?
  `).all(sessionKey, windowSize);
}

export function getCronRunHistory(jobId: string, limit: number = 5): Array<{
  session_key: string; runCount: number; totalCost: number; totalTokens: number;
  firstTs: number; lastTs: number;
}> {
  return getDb().prepare(`
    SELECT session_key,
      COUNT(*) as runCount,
      COALESCE(SUM(cost_usd), 0) as totalCost,
      COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens,
      MIN(timestamp) as firstTs, MAX(timestamp) as lastTs
    FROM usage WHERE job_id = ?
    GROUP BY session_key ORDER BY firstTs DESC LIMIT ?
  `).all(jobId, limit);
}

export function getDailyTotals(days: number = 30): Array<{ date: string; totalCost: number; totalTokens: number }> {
  const sinceMs = Date.now() - (days * 24 * 60 * 60 * 1000);
  return getDb().prepare(`
    SELECT
      DATE(timestamp / 1000, 'unixepoch', 'localtime') as date,
      COALESCE(SUM(cost_usd), 0) as totalCost,
      COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens
    FROM usage WHERE timestamp >= ?
    GROUP BY date ORDER BY date ASC
  `).all(sinceMs);
}

// --- PRD-02: Scope-filtered cost query ---

export function getCostSinceForScope(sinceMs: number, scopeFilter: { agentId?: string; jobId?: string }): CostSummary {
  let sql = `SELECT COALESCE(SUM(cost_usd),0) as totalCost, COALESCE(SUM(input_tokens),0) as totalInputTokens,
    COALESCE(SUM(output_tokens),0) as totalOutputTokens, COUNT(*) as invocationCount
    FROM usage WHERE timestamp >= ?`;
  const params: any[] = [sinceMs];
  if (scopeFilter.agentId) { sql += " AND agent_id = ?"; params.push(scopeFilter.agentId); }
  if (scopeFilter.jobId) { sql += " AND job_id = ?"; params.push(scopeFilter.jobId); }
  const row = getDb().prepare(sql).get(...params);
  return row ?? { totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, invocationCount: 0 };
}

// --- PRD-04: Cron context stats ---

export function getCronRunContextStats(jobId: string, limit: number = 5): Array<{
  session_key: string; runCount: number; totalCost: number; totalTokens: number;
  firstTs: number; lastTs: number; minContext: number; maxContext: number;
}> {
  return getDb().prepare(`
    SELECT session_key,
      COUNT(*) as runCount,
      COALESCE(SUM(cost_usd), 0) as totalCost,
      COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens,
      MIN(timestamp) as firstTs, MAX(timestamp) as lastTs,
      MIN(context_tokens) as minContext, MAX(context_tokens) as maxContext
    FROM usage WHERE job_id = ?
    GROUP BY session_key ORDER BY firstTs DESC LIMIT ?
  `).all(jobId, limit);
}

// --- PRD-03: Cost velocity query ---

export function getCostInWindow(sinceMs: number, untilMs: number): number {
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total FROM usage WHERE timestamp >= ? AND timestamp <= ?
  `).get(sinceMs, untilMs);
  return (row as any)?.total ?? 0;
}
