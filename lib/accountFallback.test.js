import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACKOFF_CONFIG,
  TRANSIENT_COOLDOWN_MS,
  MAX_RATE_LIMIT_COOLDOWN_MS,
  MODEL_LOCK_PREFIX,
  MODEL_LOCK_ALL,
  ERROR_RULES,
  getQuotaCooldown,
  checkFallbackError,
  getModelLockKey,
  isModelLockActive,
  getEarliestModelLockUntil,
  buildModelLockUpdate,
  buildClearModelLocksUpdate,
  formatRetryAfter,
} from "./accountFallback.js";

test("getQuotaCooldown grows exponentially, capped at max", () => {
  assert.equal(getQuotaCooldown(1), 2000);    // base
  assert.equal(getQuotaCooldown(2), 4000);
  assert.equal(getQuotaCooldown(3), 8000);
  assert.equal(getQuotaCooldown(5), 32000);
  // Level 15+ should cap at 5min
  assert.equal(getQuotaCooldown(20), BACKOFF_CONFIG.max);
});

test("checkFallbackError text rule wins over status (rate limit text → backoff)", () => {
  const r = checkFallbackError(500, "Rate limit reached", 0);
  assert.equal(r.shouldFallback, true);
  assert.equal(r.newBackoffLevel, 1);
  assert.equal(r.cooldownMs, 2000);
});

test("checkFallbackError 429 status → backoff", () => {
  const r = checkFallbackError(429, "", 2);
  assert.equal(r.shouldFallback, true);
  assert.equal(r.newBackoffLevel, 3);
  assert.equal(r.cooldownMs, 8000);
});

test("checkFallbackError 401 status → fixed cooldown, no backoff", () => {
  const r = checkFallbackError(401, "", 5);
  assert.equal(r.shouldFallback, true);
  assert.equal(r.cooldownMs, 2 * 60 * 1000);
  assert.equal(r.newBackoffLevel, undefined);
});

test("checkFallbackError unknown error → transient cooldown", () => {
  const r = checkFallbackError(599, "weird upstream thing", 0);
  assert.equal(r.shouldFallback, true);
  assert.equal(r.cooldownMs, TRANSIENT_COOLDOWN_MS);
});

test("checkFallbackError 'no credentials' text → long cooldown", () => {
  const r = checkFallbackError(401, "no credentials available", 0);
  assert.equal(r.shouldFallback, true);
  assert.equal(r.cooldownMs, 2 * 60 * 1000);
  assert.equal(r.newBackoffLevel, undefined);
});

test("getModelLockKey returns model-specific or all-key", () => {
  assert.equal(getModelLockKey("sonnet"), "modelLock_sonnet");
  assert.equal(getModelLockKey(null), MODEL_LOCK_ALL);
  assert.equal(getModelLockKey(undefined), MODEL_LOCK_ALL);
});

test("isModelLockActive checks per-model lock and falls back to all-lock", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();

  assert.equal(isModelLockActive({}, "sonnet"), false);
  assert.equal(isModelLockActive({ modelLock_sonnet: future }, "sonnet"), true);
  assert.equal(isModelLockActive({ modelLock_sonnet: past }, "sonnet"), false);
  assert.equal(isModelLockActive({ modelLock_sonnet: future }, "haiku"), false);
  // Account-level lock blocks any model
  assert.equal(isModelLockActive({ [MODEL_LOCK_ALL]: future }, "haiku"), true);
});

test("getEarliestModelLockUntil returns earliest future lock", () => {
  const t1 = new Date(Date.now() + 30_000).toISOString();
  const t2 = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 30_000).toISOString();
  assert.equal(
    getEarliestModelLockUntil({
      modelLock_sonnet: t2,
      modelLock_haiku: t1,
      modelLock_opus: past,  // expired, ignored
    }),
    t1
  );
  assert.equal(getEarliestModelLockUntil({}), null);
});

test("buildModelLockUpdate produces an update object with future timestamp", () => {
  const now = Date.now();
  const u = buildModelLockUpdate("sonnet", 5000);
  assert.ok(u.modelLock_sonnet);
  const t = new Date(u.modelLock_sonnet).getTime();
  assert.ok(t >= now + 4900 && t <= now + 5100);
});

test("buildClearModelLocksUpdate nulls all modelLock_* keys", () => {
  const u = buildClearModelLocksUpdate({
    modelLock_sonnet: "x",
    modelLock_haiku: "y",
    foo: "bar",
  });
  assert.deepEqual(u, { modelLock_sonnet: null, modelLock_haiku: null });
});

test("formatRetryAfter returns human-readable string", () => {
  const t = new Date(Date.now() + 90_000).toISOString();
  const out = formatRetryAfter(t);
  assert.match(out, /reset after 1m \d+s/);
  assert.equal(formatRetryAfter(null), "");
});
