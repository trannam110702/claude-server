import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-server-users-test-"));
process.env.DATABASE_PATH = path.join(tmpDir, "test.db");

const { getDb } = await import("./db.js");
const { upsertUserOnLogin, listUsers } = await import("./users.js");

before(() => {
  const db = getDb();
  db.exec("DELETE FROM users");
});

after(() => {
  try { getDb().close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("upsertUserOnLogin inserts a new row with created_at and last_login_at", () => {
  upsertUserOnLogin({ email: "alice@example.com", name: "Alice", image: "http://a/x" });
  const rows = listUsers();
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.email, "alice@example.com");
  assert.equal(r.name, "Alice");
  assert.equal(r.image, "http://a/x");
  assert.equal(r.isAdmin, false);
  assert.ok(r.createdAt);
  assert.ok(r.lastLoginAt);
  assert.equal(r.createdAt, r.lastLoginAt);
});

test("upsertUserOnLogin on re-login bumps last_login_at and preserves created_at", async () => {
  upsertUserOnLogin({ email: "bob@example.com", name: "Bob", image: null });
  const before = listUsers().find(u => u.email === "bob@example.com");
  await new Promise((r) => setTimeout(r, 5));
  upsertUserOnLogin({ email: "bob@example.com", name: "Robert", image: "http://b/x" });
  const after = listUsers().find(u => u.email === "bob@example.com");
  assert.equal(after.createdAt, before.createdAt, "created_at must not change");
  assert.notEqual(after.lastLoginAt, before.lastLoginAt, "last_login_at must update");
  assert.equal(after.name, "Robert", "name refreshed from new profile");
  assert.equal(after.image, "http://b/x", "image refreshed from new profile");
});

test("upsertUserOnLogin lowercases email", () => {
  upsertUserOnLogin({ email: "Carol@Example.COM", name: "Carol", image: null });
  const row = listUsers().find(u => u.email === "carol@example.com");
  assert.ok(row, "expected lowercased email");
});
