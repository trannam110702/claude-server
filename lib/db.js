import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "path";
import { pickPercentile } from "./percentile.js";

/**
 * SQLite — request_logs only. Account data lives in accountsStore.js
 * (LowDB + lockfile, mirroring 9router's pattern) so that the proxy and
 * Next.js processes always see the same state without WAL snapshot quirks.
 */
function resolveDbPath() {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  const dir =
    process.platform === "win32"
      ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "claude-server")
      : path.join(os.homedir(), ".claude-server");
  return path.join(dir, "usage.db");
}

const DB_PATH = resolveDbPath();

let db = null;

export function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    console.log(`[db] opening ${DB_PATH}`);
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    initSchema(db);
  }
  return db;
}

function initSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER,
      latency_ms INTEGER,
      tokens_used INTEGER,
      model TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_timestamp ON request_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_path ON request_logs(path);
  `);

  // Additive migration — newer columns added without breaking existing DBs.
  const existing = new Set(
    database.prepare("PRAGMA table_info(request_logs)").all().map((c) => c.name)
  );
  const addColumn = (name, decl) => {
    if (!existing.has(name)) {
      database.exec(`ALTER TABLE request_logs ADD COLUMN ${name} ${decl}`);
      existing.add(name);
    }
  };
  addColumn("account_id", "TEXT");
  addColumn("input_tokens", "INTEGER");
  addColumn("output_tokens", "INTEGER");
  addColumn("stream", "INTEGER"); // 0/1
  addColumn("user_token_id", "TEXT");
  addColumn("user_email", "TEXT");
  database.exec(`CREATE INDEX IF NOT EXISTS idx_account ON request_logs(account_id);`);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_user_token ON request_logs(user_token_id);`);
}

export function insertRequestLog(log) {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO request_logs (
      timestamp, method, path, status, latency_ms,
      tokens_used, model, error,
      account_id, input_tokens, output_tokens, stream,
      user_token_id, user_email
    )
    VALUES (
      @timestamp, @method, @path, @status, @latency_ms,
      @tokens_used, @model, @error,
      @account_id, @input_tokens, @output_tokens, @stream,
      @user_token_id, @user_email
    )
  `);
  stmt.run({
    tokens_used: null,
    model: null,
    error: null,
    account_id: null,
    input_tokens: null,
    output_tokens: null,
    stream: null,
    user_token_id: null,
    user_email: null,
    ...log,
  });
}

export function queryLogs(options = {}) {
  const database = getDb();
  const { page = 1, limit = 50, startDate, endDate, endpoint } = options;
  const offset = (page - 1) * limit;

  let where = "1=1";
  const params = {};

  if (startDate) {
    where += " AND timestamp >= @startDate";
    params.startDate = startDate;
  }
  if (endDate) {
    where += " AND timestamp <= @endDate";
    params.endDate = endDate;
  }
  if (endpoint) {
    where += " AND path LIKE @endpoint";
    params.endpoint = `%${endpoint}%`;
  }

  const countStmt = database.prepare(`SELECT COUNT(*) as total FROM request_logs WHERE ${where}`);
  const { total } = countStmt.get(params);

  const stmt = database.prepare(`
    SELECT * FROM request_logs
    WHERE ${where}
    ORDER BY timestamp DESC
    LIMIT @limit OFFSET @offset
  `);
  const rows = stmt.all({ ...params, limit, offset });

  return { rows, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export function getStats() {
  const database = getDb();
  const today = new Date().toISOString().split("T")[0];

  const requestsToday = database
    .prepare("SELECT COUNT(*) as count FROM request_logs WHERE timestamp LIKE ?")
    .get(`${today}%`);

  const avgLatency = database
    .prepare("SELECT AVG(latency_ms) as avg FROM request_logs WHERE timestamp LIKE ?")
    .get(`${today}%`);

  const errorCount = database
    .prepare("SELECT COUNT(*) as count FROM request_logs WHERE timestamp LIKE ? AND error IS NOT NULL")
    .get(`${today}%`);

  return {
    requestsToday: requestsToday.count,
    avgLatencyMs: avgLatency.avg ? Math.round(avgLatency.avg) : 0,
    errorCountToday: errorCount.count,
  };
}

// ──────────────────────────────────────────────────────────────────
// Latency percentiles — backs the overview /api/stats/latency endpoint
// ──────────────────────────────────────────────────────────────────

const LATENCY_BUCKET_SECONDS = {
  "24h": 900,    // 15 min × 96 buckets
  "7d": 3600,    // 1 hour × 168 buckets
};

const LATENCY_WINDOW_HOURS = {
  "24h": 24,
  "7d": 24 * 7,
};

const VALID_LATENCY_PERIODS = new Set(["24h", "7d"]);

/**
 * Compute p50 / p95 / p99 latency over a rolling window, bucketed for charting.
 *
 * - Sample filter: status = 200 only (errors poison the distribution).
 * - Bucketing: 15-min buckets for 24h; 1-hour buckets for 7d.
 * - Empty buckets emit { p50: null, p95: null, p99: null, n: 0 } so the
 *   chart can render gaps.
 *
 * @param {"24h" | "7d" | string} period — invalid values fall back to "24h"
 * @returns {{ period: string, bucketSeconds: number, points: Array<{
 *   bucket: string, p50: number|null, p95: number|null, p99: number|null, n: number
 * }> }}
 */
export function getLatencyPercentiles(period = "24h") {
  if (!VALID_LATENCY_PERIODS.has(period)) period = "24h";
  const bucketSeconds = LATENCY_BUCKET_SECONDS[period];
  const bucketMs = bucketSeconds * 1000;
  const numBuckets = (LATENCY_WINDOW_HOURS[period] * 3600) / bucketSeconds;

  // The rightmost emitted bucket is the in-progress one (its start is the
  // bucket boundary just at or before "now"). The window therefore covers
  // (numBuckets - 1) completed buckets plus the in-progress one.
  const inProgressStart = Math.floor(Date.now() / bucketMs) * bucketMs;
  const startMs = inProgressStart - (numBuckets - 1) * bucketMs;
  const upperMs = inProgressStart + bucketMs; // exclusive — covers in-progress bucket
  const cutoffIso = new Date(startMs).toISOString();

  const database = getDb();
  const rows = database
    .prepare(`
      SELECT timestamp, latency_ms
      FROM request_logs
      WHERE status = 200 AND timestamp >= @cutoff
    `)
    .all({ cutoff: cutoffIso });

  // Group rows into bucket → array of latency_ms.
  const buckets = new Map();
  for (const r of rows) {
    if (r.latency_ms == null) continue;
    const ts = new Date(r.timestamp).getTime();
    if (!Number.isFinite(ts) || ts < startMs || ts >= upperMs) continue;
    const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
    let arr = buckets.get(bucketStart);
    if (!arr) { arr = []; buckets.set(bucketStart, arr); }
    arr.push(r.latency_ms);
  }

  // Emit one point per bucket: startMs, startMs+bucketMs, …, inProgressStart.
  const points = [];
  for (let b = startMs; b <= inProgressStart; b += bucketMs) {
    const arr = buckets.get(b) || [];
    arr.sort((x, y) => x - y);
    points.push({
      bucket: new Date(b).toISOString(),
      p50: pickPercentile(arr, 50),
      p95: pickPercentile(arr, 95),
      p99: pickPercentile(arr, 99),
      n: arr.length,
    });
  }

  return { period, bucketSeconds, points };
}

// ──────────────────────────────────────────────────────────────────
// Usage statistics (period-filtered) — backs the /dashboard/usage page
// ──────────────────────────────────────────────────────────────────

const PERIOD_HOURS = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
  all: null,
};

/**
 * Compute aggregated usage for a given period:
 * - totals (requests, input/output tokens, errors, avg latency)
 * - per-account breakdown
 * - per-model breakdown
 * - time-series buckets (hourly for 24h, daily for 7d/30d/all)
 *
 * @param {"24h" | "7d" | "30d" | "all"} period
 * @returns aggregate stats object
 */
export function getUsageStats(period = "7d") {
  const database = getDb();
  const hours = PERIOD_HOURS[period];
  const cutoffIso = hours
    ? new Date(Date.now() - hours * 3_600_000).toISOString()
    : null;
  const where = cutoffIso ? "timestamp >= @cutoff" : "1=1";
  const params = cutoffIso ? { cutoff: cutoffIso } : {};

  const totals = database
    .prepare(`
      SELECT
        COUNT(*) AS total_requests,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(tokens_used), 0) AS total_tokens,
        SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS error_count,
        AVG(latency_ms) AS avg_latency
      FROM request_logs
      WHERE ${where}
    `)
    .get(params);

  const byAccount = database
    .prepare(`
      SELECT
        account_id,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(tokens_used), 0) AS total_tokens
      FROM request_logs
      WHERE ${where}
      GROUP BY account_id
      ORDER BY requests DESC
    `)
    .all(params);

  const byModel = database
    .prepare(`
      SELECT
        model,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(tokens_used), 0) AS total_tokens
      FROM request_logs
      WHERE ${where}
      GROUP BY model
      ORDER BY requests DESC
    `)
    .all(params);

  // Time-series: hourly for 24h, daily for everything else.
  // strftime in better-sqlite3 operates on the ISO timestamp string we store.
  const isHourly = period === "24h";
  const bucketExpr = isHourly
    ? "strftime('%Y-%m-%dT%H:00:00.000Z', timestamp)"
    : "strftime('%Y-%m-%dT00:00:00.000Z', timestamp)";

  const seriesRows = database
    .prepare(`
      SELECT
        ${bucketExpr} AS bucket,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM request_logs
      WHERE ${where}
      GROUP BY bucket
      ORDER BY bucket ASC
    `)
    .all(params);

  // Zero-fill empty buckets so the chart x-axis is continuous.
  const series = zeroFillSeries(period, seriesRows);

  return {
    period,
    totals: {
      requests: totals.total_requests || 0,
      inputTokens: totals.total_input_tokens || 0,
      outputTokens: totals.total_output_tokens || 0,
      totalTokens: totals.total_tokens || 0,
      errors: totals.error_count || 0,
      avgLatencyMs: totals.avg_latency ? Math.round(totals.avg_latency) : 0,
    },
    byAccount,
    byModel,
    series,
  };
}

// ──────────────────────────────────────────────────────────────────
// Per-user leaderboard — aggregates request_logs by user_email
// ──────────────────────────────────────────────────────────────────

const VALID_LEADERBOARD_SORTS = new Set(["total_tokens", "requests"]);

export function queryLeaderboard(period = "7d", sort = "total_tokens") {
  if (!VALID_LEADERBOARD_SORTS.has(sort)) sort = "total_tokens";
  const database = getDb();
  const hours = PERIOD_HOURS[period];
  const cutoffIso = hours
    ? new Date(Date.now() - hours * 3_600_000).toISOString()
    : null;

  const where = cutoffIso
    ? "user_email IS NOT NULL AND timestamp >= @cutoff"
    : "user_email IS NOT NULL";
  const params = cutoffIso ? { cutoff: cutoffIso } : {};

  const orderBy = sort === "requests" ? "requests DESC" : "total_tokens DESC";

  const rows = database
    .prepare(`
      SELECT
        user_email,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS total_tokens,
        MAX(timestamp) AS last_active
      FROM request_logs
      WHERE ${where}
      GROUP BY user_email
      ORDER BY ${orderBy}
      LIMIT 100
    `)
    .all(params);

  return rows;
}

function zeroFillSeries(period, rows) {
  const map = new Map(rows.map((r) => [r.bucket, r]));
  const out = [];
  const now = new Date();

  if (period === "24h") {
    // 24 hourly buckets, ending at the current hour
    for (let i = 23; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 3_600_000);
      d.setUTCMinutes(0, 0, 0);
      const key = d.toISOString();
      const r = map.get(key);
      out.push({
        bucket: key,
        requests: r?.requests || 0,
        input_tokens: r?.input_tokens || 0,
        output_tokens: r?.output_tokens || 0,
      });
    }
    return out;
  }

  const days = period === "7d" ? 7 : period === "30d" ? 30 : null;
  if (days) {
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86_400_000);
      d.setUTCHours(0, 0, 0, 0);
      const key = d.toISOString();
      const r = map.get(key);
      out.push({
        bucket: key,
        requests: r?.requests || 0,
        input_tokens: r?.input_tokens || 0,
        output_tokens: r?.output_tokens || 0,
      });
    }
    return out;
  }

  // all: just return whatever the DB had (sparse)
  return rows.map((r) => ({
    bucket: r.bucket,
    requests: r.requests || 0,
    input_tokens: r.input_tokens || 0,
    output_tokens: r.output_tokens || 0,
  }));
}
