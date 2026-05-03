/**
 * Tests run sequentially and SHARE the account store. The `before` hook
 * clears it once at the start of the file; later tests assume the accounts
 * created by earlier tests still exist (e.g. test 3 reads `accts[1]` after
 * test 2 has created two accounts in order). When inserting a new test in
 * the middle, either preserve the existing fixtures or reset state explicitly.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-server-store-test-"));
process.env.CLAUDE_SERVER_DATA_DIR = tmpDir;

const {
  createAccount,
  pickActiveAccount,
  updateAccountFlags,
  listAccounts,
  deleteAccount,
} = await import("./accountsStore.js");

before(async () => {
  for (const a of await listAccounts()) await deleteAccount(a.id);
});

async function freshAcct(name, overrides = {}) {
  return createAccount({
    name,
    email: `${name}@x`,
    accessToken: `tok-${name}`,
    refreshToken: `ref-${name}`,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    isActive: true,
    ...overrides,
  });
}

test("pickActiveAccount with empty store returns null", async () => {
  const r = await pickActiveAccount({});
  assert.equal(r, null);
});

test("pickActiveAccount returns LRU when no preferred", async () => {
  const a = await freshAcct("a");
  await new Promise((r) => setTimeout(r, 5));
  const b = await freshAcct("b");
  // Both unused → tiebreak on createdAt ascending → a first
  const first = await pickActiveAccount({});
  assert.equal(first.id, a.id);
  // Now a has lastUsedAt; b is older by lastUsedAt (null) → b
  const second = await pickActiveAccount({});
  assert.equal(second.id, b.id);
});

test("pickActiveAccount honors preferredAccountId when eligible", async () => {
  const accts = await listAccounts();
  const target = accts[1];
  const r = await pickActiveAccount({ preferredAccountId: target.id });
  assert.equal(r.id, target.id);
});

test("pickActiveAccount excludes excludeIds", async () => {
  const accts = await listAccounts();
  const exclude = new Set([accts[0].id]);
  const r = await pickActiveAccount({ excludeIds: exclude });
  assert.notEqual(r.id, accts[0].id);
});

test("pickActiveAccount filters out model-locked accounts", async () => {
  const accts = await listAccounts();
  const locked = accts[0];
  const future = new Date(Date.now() + 60_000).toISOString();
  await updateAccountFlags(locked.id, { modelLock_sonnet: future });

  const r = await pickActiveAccount({ model: "sonnet" });
  assert.notEqual(r.id, locked.id);

  // Different model still available
  const haiku = await pickActiveAccount({ model: "haiku" });
  assert.ok(haiku);
});

test("pickActiveAccount returns {allLocked} when every eligible account is model-locked", async () => {
  const accts = await listAccounts();
  const future = new Date(Date.now() + 30_000).toISOString();
  for (const a of accts) {
    await updateAccountFlags(a.id, {
      modelLock_sonnet: future,
      lastError: "rate limit",
      errorCode: 429,
    });
  }
  const r = await pickActiveAccount({ model: "sonnet" });
  assert.ok(r);
  assert.equal(r.allLocked, true);
  assert.ok(r.retryAfter);
  assert.match(r.retryAfterHuman, /reset after/);
});

test("updateAccountFlags accepts modelLock_*, backoffLevel, errorCode, lastError, lastErrorAt, lastUsedAt", async () => {
  const accts = await listAccounts();
  const id = accts[0].id;
  await updateAccountFlags(id, {
    modelLock_sonnet: null,
    backoffLevel: 3,
    errorCode: 429,
    lastError: "rate limit",
    lastErrorAt: new Date().toISOString(),
  });
  const after = (await listAccounts()).find((a) => a.id === id);
  assert.equal(after.backoffLevel, 3);
  assert.equal(after.errorCode, 429);
  assert.equal(after.modelLock_sonnet ?? null, null);
});
