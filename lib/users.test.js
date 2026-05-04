import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-server-users-test-"));
process.env.DATABASE_PATH = path.join(tmpDir, "test.db");

const { getDb } = await import("./db.js");
const { upsertUserOnLogin, listUsers, isAdminInDb, setAdminInDb } = await import("./users.js");

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
  const first = listUsers().find(u => u.email === "bob@example.com");
  await new Promise((r) => setTimeout(r, 5));
  upsertUserOnLogin({ email: "bob@example.com", name: "Robert", image: "http://b/x" });
  const second = listUsers().find(u => u.email === "bob@example.com");
  assert.equal(second.createdAt, first.createdAt, "created_at must not change");
  assert.notEqual(second.lastLoginAt, first.lastLoginAt, "last_login_at must update");
  assert.equal(second.name, "Robert", "name refreshed from new profile");
  assert.equal(second.image, "http://b/x", "image refreshed from new profile");
});

test("upsertUserOnLogin lowercases email", () => {
  upsertUserOnLogin({ email: "Carol@Example.COM", name: "Carol", image: null });
  const row = listUsers().find(u => u.email === "carol@example.com");
  assert.ok(row, "expected lowercased email");
});

test("isAdminInDb returns false for non-admin and unknown emails", () => {
  upsertUserOnLogin({ email: "dave@example.com", name: "Dave", image: null });
  assert.equal(isAdminInDb("dave@example.com"), false);
  assert.equal(isAdminInDb("ghost@example.com"), false);
});

test("isAdminInDb returns true after setAdminInDb(email, true)", () => {
  upsertUserOnLogin({ email: "erin@example.com", name: "Erin", image: null });
  setAdminInDb("erin@example.com", true);
  assert.equal(isAdminInDb("erin@example.com"), true);

  setAdminInDb("erin@example.com", false);
  assert.equal(isAdminInDb("erin@example.com"), false);
});

test("isAdminInDb is case-insensitive", () => {
  upsertUserOnLogin({ email: "frank@example.com", name: "Frank", image: null });
  setAdminInDb("Frank@Example.COM", true);
  assert.equal(isAdminInDb("FRANK@example.com"), true);
});

test("setAdminInDb returns false when target email has no row", () => {
  // We don't auto-create rows for unknown emails — promotion only works on
  // users who have signed in at least once.
  const ok = setAdminInDb("nobody@example.com", true);
  assert.equal(ok, false);
});
