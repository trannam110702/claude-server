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
