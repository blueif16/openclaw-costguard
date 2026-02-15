import Database from "better-sqlite3";
import path from "path";
import os from "os";

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
const DB_PATH = path.join(OPENCLAW_HOME, "costguard.db");

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    initSchema(db);
  }
  return db;
}

function initSchema(db: Database.Database): void {
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
      duration_ms INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_source ON usage(source);
    CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(model);
    CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_key);
    CREATE INDEX IF NOT EXISTS idx_usage_job ON usage(job_id);
  `);
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
}

export function insertUsage(record: UsageRecord): void {
  const stmt = getDb().prepare(`
    INSERT INTO usage (timestamp, session_key, agent_id, source, job_id, model, provider,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    record.timestamp, record.sessionKey, record.agentId, record.source,
    record.jobId, record.model, record.provider,
    record.inputTokens, record.outputTokens, record.cacheReadTokens,
    record.cacheWriteTokens, record.costUsd, record.durationMs
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
  return getDb().prepare(`
    SELECT
      COALESCE(SUM(cost_usd), 0) as totalCost,
      COALESCE(SUM(input_tokens), 0) as totalInputTokens,
      COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
      COUNT(*) as invocationCount
    FROM usage WHERE timestamp >= ?
  `).get(sinceMs) as CostSummary;
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
  `).all(sinceMs) as Array<{ model: string } & CostSummary>;
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
  `).all(sinceMs) as Array<{ source: string; job_id: string | null } & CostSummary>;
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
  `).all(sinceMs, limit) as Array<{ session_key: string } & CostSummary>;
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
  `).all(sinceMs) as Array<{ date: string; totalCost: number; totalTokens: number }>;
}
