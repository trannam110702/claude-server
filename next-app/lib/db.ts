import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), "..", "data", "usage.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    initSchema(db);
  }
  return db;
}

function initSchema(database: Database.Database) {
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
}

export interface RequestLog {
  id?: number;
  timestamp: string;
  method: string;
  path: string;
  status: number;
  latency_ms: number;
  tokens_used?: number;
  model?: string;
  error?: string;
}

export function insertRequestLog(log: RequestLog): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO request_logs (timestamp, method, path, status, latency_ms, tokens_used, model, error)
    VALUES (@timestamp, @method, @path, @status, @latency_ms, @tokens_used, @model, @error)
  `);
  stmt.run(log);
}

export function queryLogs(options: {
  page?: number;
  limit?: number;
  startDate?: string;
  endDate?: string;
  endpoint?: string;
}) {
  const database = getDb();
  const { page = 1, limit = 50, startDate, endDate, endpoint } = options;
  const offset = (page - 1) * limit;

  let where = "1=1";
  const params: Record<string, any> = {};

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
  const { total } = countStmt.get(params) as { total: number };

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
    .get(`${today}%`) as { count: number };

  const avgLatency = database
    .prepare("SELECT AVG(latency_ms) as avg FROM request_logs WHERE timestamp LIKE ?")
    .get(`${today}%`) as { avg: number | null };

  const errorCount = database
    .prepare("SELECT COUNT(*) as count FROM request_logs WHERE timestamp LIKE ? AND error IS NOT NULL")
    .get(`${today}%`) as { count: number };

  return {
    requestsToday: requestsToday.count,
    avgLatencyMs: avgLatency.avg ? Math.round(avgLatency.avg) : 0,
    errorCountToday: errorCount.count,
  };
}