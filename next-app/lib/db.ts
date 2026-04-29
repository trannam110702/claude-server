// Re-export the shared DB module from the project root.
// Single source of truth so the proxy (Node ESM) and Next.js can share schema/queries.
// @ts-ignore - JS module without bundled types
export { getDb, insertRequestLog, queryLogs, getStats } from "../../lib/db.js";

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
