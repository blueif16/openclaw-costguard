"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDb = getDb;
exports.closeDb = closeDb;
exports.insertUsage = insertUsage;
exports.getCostSince = getCostSince;
exports.getCostByModel = getCostByModel;
exports.getCostBySource = getCostBySource;
exports.getCostBySession = getCostBySession;
exports.getSessionTurns = getSessionTurns;
exports.getCronRunHistory = getCronRunHistory;
exports.getDailyTotals = getDailyTotals;
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || node_path_1.default.join(node_os_1.default.homedir(), ".openclaw");
const DB_PATH = node_path_1.default.join(OPENCLAW_HOME, "costguard.db");
let db;
let DatabaseSync;
function getDb() {
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
function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}
function initSchema() {
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
function insertUsage(record) {
    const stmt = getDb().prepare(`
    INSERT INTO usage (timestamp, session_key, agent_id, source, job_id, model, provider,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    stmt.run(record.timestamp, record.sessionKey, record.agentId, record.source, record.jobId, record.model, record.provider, record.inputTokens, record.outputTokens, record.cacheReadTokens, record.cacheWriteTokens, record.costUsd, record.durationMs);
}
function getCostSince(sinceMs) {
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
function getCostByModel(sinceMs) {
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
function getCostBySource(sinceMs) {
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
function getCostBySession(sinceMs, limit = 10) {
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
function getSessionTurns(sessionKey) {
    return getDb().prepare(`
    SELECT timestamp, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, duration_ms
    FROM usage WHERE session_key = ? ORDER BY timestamp ASC
  `).all(sessionKey);
}
function getCronRunHistory(jobId, limit = 5) {
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
function getDailyTotals(days = 30) {
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
