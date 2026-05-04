import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-server-users-test-"));
process.env.DATABASE_PATH = path.join(tmpDir, "test.db");

const { getDb } = await import("./db.js");
const { upsertUserOnLogin, listUsers, isAdminInDb, setAdminInDb, inviteUser, getUserPin, setUserPin, clearUserPin, getOrAssignUserPin } = await import("./users.js");

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

test("inviteUser pre-creates a row that listUsers can see, with last_login_at === created_at", () => {
  const result = inviteUser({ email: "Greg@Example.com", isAdmin: true });
  assert.equal(result.created, true);
  const row = listUsers().find(u => u.email === "greg@example.com");
  assert.ok(row, "expected lowercased row");
  assert.equal(row.isAdmin, true);
  assert.equal(row.name, null);
  assert.equal(row.image, null);
  assert.equal(row.lastLoginAt, row.createdAt, "never-signed-in marker");
});

test("inviteUser returns { created: false } when row already exists", () => {
  inviteUser({ email: "hank@example.com", isAdmin: true });
  const second = inviteUser({ email: "hank@example.com", isAdmin: false });
  assert.equal(second.created, false);
  // Existing row's is_admin must NOT be overwritten by a duplicate invite.
  assert.equal(isAdminInDb("hank@example.com"), true);
});

test("upsertUserOnLogin after inviteUser bumps last_login_at past created_at", async () => {
  inviteUser({ email: "ivy@example.com", isAdmin: true });
  const beforeLogin = listUsers().find(u => u.email === "ivy@example.com");
  assert.equal(beforeLogin.lastLoginAt, beforeLogin.createdAt);
  await new Promise((r) => setTimeout(r, 5));
  upsertUserOnLogin({ email: "ivy@example.com", name: "Ivy", image: "http://i/x" });
  const afterLogin = listUsers().find(u => u.email === "ivy@example.com");
  assert.notEqual(afterLogin.lastLoginAt, afterLogin.createdAt, "first signin moves last_login_at");
  assert.equal(afterLogin.isAdmin, true, "is_admin preserved through signin");
  assert.equal(afterLogin.name, "Ivy", "name set from Google profile");
});

test("getUserPin returns null for users with no pin set", () => {
  upsertUserOnLogin({ email: "pin1@x", name: null, image: null });
  assert.equal(getUserPin("pin1@x"), null);
});

test("setUserPin then getUserPin round-trips", () => {
  upsertUserOnLogin({ email: "pin2@x", name: null, image: null });
  setUserPin("pin2@x", "acct-A");
  assert.equal(getUserPin("pin2@x"), "acct-A");
});

test("setUserPin lowercases email", () => {
  upsertUserOnLogin({ email: "pin3@x", name: null, image: null });
  setUserPin("Pin3@X", "acct-B");
  assert.equal(getUserPin("PIN3@x"), "acct-B");
});

test("clearUserPin removes the pin", () => {
  upsertUserOnLogin({ email: "pin4@x", name: null, image: null });
  setUserPin("pin4@x", "acct-C");
  clearUserPin("pin4@x");
  assert.equal(getUserPin("pin4@x"), null);
});

test("getOrAssignUserPin returns existing pin without picking", () => {
  upsertUserOnLogin({ email: "pin5@x", name: null, image: null });
  setUserPin("pin5@x", "acct-existing");
  const candidates = [
    { id: "acct-existing", lastUsedAt: "2026-05-04T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
    { id: "acct-X", lastUsedAt: null, createdAt: "2026-01-01T00:00:00Z" },
    { id: "acct-Y", lastUsedAt: null, createdAt: "2026-01-02T00:00:00Z" },
  ];
  // acct-X would be the natural pick (oldest lastUsedAt, oldest createdAt);
  // assertion that "acct-existing" is returned proves the early-return path
  // is taken when the pin is valid.
  assert.equal(getOrAssignUserPin("pin5@x", candidates), "acct-existing");
});

test("getOrAssignUserPin picks least-used candidate when no pin set", () => {
  upsertUserOnLogin({ email: "pin6@x", name: null, image: null });
  // Y was used more recently; X should win.
  const candidates = [
    { id: "acct-X", lastUsedAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
    { id: "acct-Y", lastUsedAt: "2026-05-04T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
  ];
  const pinned = getOrAssignUserPin("pin6@x", candidates);
  assert.equal(pinned, "acct-X");
  // Persisted
  assert.equal(getUserPin("pin6@x"), "acct-X");
});

test("getOrAssignUserPin breaks ties on createdAt (older wins)", () => {
  upsertUserOnLogin({ email: "pin7@x", name: null, image: null });
  const candidates = [
    { id: "acct-newer", lastUsedAt: null, createdAt: "2026-02-01T00:00:00Z" },
    { id: "acct-older", lastUsedAt: null, createdAt: "2026-01-01T00:00:00Z" },
  ];
  assert.equal(getOrAssignUserPin("pin7@x", candidates), "acct-older");
});

test("getOrAssignUserPin returns null when no candidates", () => {
  upsertUserOnLogin({ email: "pin8@x", name: null, image: null });
  assert.equal(getOrAssignUserPin("pin8@x", []), null);
  assert.equal(getUserPin("pin8@x"), null);
});

test("getOrAssignUserPin returns null when user has no row (do not create)", () => {
  // No upsertUserOnLogin for "ghost@x" — pinning should silently no-op rather
  // than auto-creating a user; pin lifetime mirrors row lifetime.
  const candidates = [{ id: "acct-X", lastUsedAt: null, createdAt: "2026-01-01T00:00:00Z" }];
  assert.equal(getOrAssignUserPin("ghost@x", candidates), null);
});

test("getOrAssignUserPin auto-clears stale pin when pinned account is no longer a candidate", () => {
  upsertUserOnLogin({ email: "pin9@x", name: null, image: null });
  setUserPin("pin9@x", "acct-DELETED");
  // Pinned account isn't in the candidate list — repin to least-used available.
  const candidates = [
    { id: "acct-X", lastUsedAt: null, createdAt: "2026-01-01T00:00:00Z" },
    { id: "acct-Y", lastUsedAt: "2026-05-04T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
  ];
  assert.equal(getOrAssignUserPin("pin9@x", candidates), "acct-X");
  assert.equal(getUserPin("pin9@x"), "acct-X");
});
