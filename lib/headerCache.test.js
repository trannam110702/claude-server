import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-server-hc-test-"));
process.env.CLAUDE_SERVER_DATA_DIR = tmpDir;

const { cacheClaudeHeaders, getCachedClaudeHeaders, _resetForTests } = await import("./headerCache.js");

beforeEach(() => _resetForTests());
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test("getCachedClaudeHeaders returns null on cold start", () => {
  assert.equal(getCachedClaudeHeaders(), null);
});

test("cacheClaudeHeaders captures when User-Agent contains claude-cli", () => {
  cacheClaudeHeaders({
    "user-agent": "claude-cli/2.1.92 (external, cli)",
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
    "x-stainless-lang": "js",
    "x-app": "cli",
    "content-type": "application/json", // not in allowlist; should be filtered out
  });
  const cached = getCachedClaudeHeaders();
  assert.equal(cached["user-agent"], "claude-cli/2.1.92 (external, cli)");
  assert.equal(cached["anthropic-beta"], "claude-code-20250219,oauth-2025-04-20");
  assert.equal(cached["x-stainless-lang"], "js");
  assert.equal(cached["content-type"], undefined);
});

test("cacheClaudeHeaders ignores requests that don't look like Claude Code", () => {
  cacheClaudeHeaders({
    "user-agent": "curl/8.0",
    "anthropic-beta": "x",
  });
  assert.equal(getCachedClaudeHeaders(), null);
});

test("cacheClaudeHeaders accepts x-app=cli even without claude-cli UA", () => {
  cacheClaudeHeaders({
    "user-agent": "Some-Wrapper/1.0",
    "x-app": "cli",
    "anthropic-beta": "y",
  });
  const cached = getCachedClaudeHeaders();
  assert.ok(cached, "expected to cache when x-app=cli");
});

test("getCachedClaudeHeaders persists across module reload (file-backed)", async () => {
  cacheClaudeHeaders({
    "user-agent": "claude-cli/2.1.99 (external, cli)",
    "anthropic-beta": "fresh-flag",
  });
  // Wait a tick so the write completes
  await new Promise((r) => setImmediate(r));
  // Force re-import by busting the ESM cache (Node's test runner shares module
  // graph, so we reach in via the test hook).
  _resetForTests({ keepFile: true });
  // First lookup after reset should hydrate from disk
  const cached = getCachedClaudeHeaders();
  assert.ok(cached);
  assert.equal(cached["user-agent"], "claude-cli/2.1.99 (external, cli)");
});

test("cacheClaudeHeaders is a no-op when headers is null/non-object", () => {
  cacheClaudeHeaders(null);
  cacheClaudeHeaders(undefined);
  cacheClaudeHeaders("not an object");
  assert.equal(getCachedClaudeHeaders(), null);
});
