import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-server-db-test-"));
process.env.DATABASE_PATH = path.join(tmpDir, "test.db");

const { getDb, insertRequestLog, queryLeaderboard } = await import("./db.js");

before(() => {
  const db = getDb();
  db.exec("DELETE FROM request_logs");
});

after(() => {
  try {
    getDb().close();
  } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function logFor({ user, input, output, ts, model = "sonnet" }) {
  insertRequestLog({
    timestamp: ts,
    method: "POST",
    path: "/v1/messages",
    status: 200,
    latency_ms: 100,
    model,
    user_email: user,
    input_tokens: input,
    output_tokens: output,
    tokens_used: input + output,
  });
}

test("queryLeaderboard groups by user_email and sorts by total_tokens desc", () => {
  const now = new Date().toISOString();
  logFor({ user: "alice@x", input: 1000, output: 500, ts: now });
  logFor({ user: "alice@x", input: 200, output: 100, ts: now });
  logFor({ user: "bob@x",   input: 5000, output: 2000, ts: now });
  logFor({ user: "carol@x", input: 100, output: 50, ts: now });

  const rows = queryLeaderboard("all", "total_tokens");
  assert.equal(rows.length, 3);
  assert.equal(rows[0].user_email, "bob@x");
  assert.equal(rows[0].total_tokens, 7000);
  assert.equal(rows[0].requests, 1);
  assert.equal(rows[1].user_email, "alice@x");
  assert.equal(rows[1].total_tokens, 1800);
  assert.equal(rows[1].requests, 2);
  assert.equal(rows[2].user_email, "carol@x");
});

test("queryLeaderboard sort=requests orders by request count", () => {
  const rows = queryLeaderboard("all", "requests");
  assert.equal(rows[0].user_email, "alice@x"); // 2 requests
  assert.equal(rows[0].requests, 2);
});

test("queryLeaderboard period=24h filters by cutoff", () => {
  const oldTs = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  logFor({ user: "ancient@x", input: 999999, output: 0, ts: oldTs });
  const rows = queryLeaderboard("24h", "total_tokens");
  assert.equal(rows.find((r) => r.user_email === "ancient@x"), undefined);
});

test("queryLeaderboard excludes rows with NULL user_email", () => {
  insertRequestLog({
    timestamp: new Date().toISOString(),
    method: "POST",
    path: "/v1/messages",
    status: 200,
    latency_ms: 100,
    user_email: null,
    input_tokens: 100,
    output_tokens: 100,
    tokens_used: 200,
  });
  const rows = queryLeaderboard("all", "total_tokens");
  assert.equal(rows.find((r) => r.user_email === null), undefined);
});

const { getLatencyPercentiles } = await import("./db.js");

function logLatency({ ts, status = 200, latency }) {
  insertRequestLog({
    timestamp: ts,
    method: "POST",
    path: "/v1/messages",
    status,
    latency_ms: latency,
  });
}

test("getLatencyPercentiles 24h returns 96 buckets of 15 minutes", () => {
  getDb().exec("DELETE FROM request_logs");
  const result = getLatencyPercentiles("24h");
  assert.equal(result.period, "24h");
  assert.equal(result.bucketSeconds, 900);
  assert.equal(result.points.length, 96);
});

test("getLatencyPercentiles 7d returns 168 buckets of 1 hour", () => {
  getDb().exec("DELETE FROM request_logs");
  const result = getLatencyPercentiles("7d");
  assert.equal(result.period, "7d");
  assert.equal(result.bucketSeconds, 3600);
  assert.equal(result.points.length, 168);
});

test("getLatencyPercentiles emits null/0 for empty buckets", () => {
  getDb().exec("DELETE FROM request_logs");
  const result = getLatencyPercentiles("24h");
  for (const pt of result.points) {
    assert.equal(pt.p50, null);
    assert.equal(pt.p95, null);
    assert.equal(pt.p99, null);
    assert.equal(pt.n, 0);
  }
});

test("getLatencyPercentiles excludes non-200 rows from the sample", () => {
  getDb().exec("DELETE FROM request_logs");
  const now = new Date().toISOString();
  logLatency({ ts: now, status: 200, latency: 100 });
  logLatency({ ts: now, status: 500, latency: 99999 });

  const result = getLatencyPercentiles("24h");
  const last = result.points[result.points.length - 1];
  assert.equal(last.n, 1);
  assert.equal(last.p50, 100);
  assert.equal(last.p99, 100);
});

test("getLatencyPercentiles computes percentiles per bucket", () => {
  getDb().exec("DELETE FROM request_logs");
  const now = new Date().toISOString();
  for (const ms of [10, 20, 30, 40, 50]) {
    logLatency({ ts: now, status: 200, latency: ms });
  }
  const result = getLatencyPercentiles("24h");
  const last = result.points[result.points.length - 1];
  assert.equal(last.n, 5);
  assert.equal(last.p50, 30);
  assert.equal(last.p95, 48);
  assert.equal(last.p99, 50);
});

test("getLatencyPercentiles drops rows older than the window", () => {
  getDb().exec("DELETE FROM request_logs");
  const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
  const now = new Date().toISOString();
  logLatency({ ts: old, status: 200, latency: 9999 });
  logLatency({ ts: now, status: 200, latency: 50 });

  const result = getLatencyPercentiles("24h");
  const total = result.points.reduce((s, p) => s + p.n, 0);
  assert.equal(total, 1);
});

test("getLatencyPercentiles defaults invalid period to 24h", () => {
  getDb().exec("DELETE FROM request_logs");
  const result = getLatencyPercentiles("nonsense");
  assert.equal(result.period, "24h");
  assert.equal(result.points.length, 96);
});
