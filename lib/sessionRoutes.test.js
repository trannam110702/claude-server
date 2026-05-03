import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getRoute,
  setRoute,
  deleteRoute,
  _pruneNow,
  _setTtlForTests,
} from "./sessionRoutes.js";

test("setRoute then getRoute returns same accountId", () => {
  setRoute("k1", "acct-1");
  assert.equal(getRoute("k1"), "acct-1");
});

test("getRoute returns null for missing key", () => {
  assert.equal(getRoute("does-not-exist"), null);
});

test("getRoute returns null for null sessionKey, no throw", () => {
  assert.equal(getRoute(null), null);
});

test("setRoute is no-op for null sessionKey or null accountId", () => {
  setRoute(null, "acct-x");
  setRoute("k-null-acct", null);
  assert.equal(getRoute("k-null-acct"), null);
});

test("getRoute returns null after TTL elapses", async () => {
  _setTtlForTests(50); // 50ms
  setRoute("k-ttl", "acct-2");
  assert.equal(getRoute("k-ttl"), "acct-2");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(getRoute("k-ttl"), null);
  _setTtlForTests(2 * 60 * 60 * 1000); // restore default
});

test("deleteRoute removes the entry", () => {
  setRoute("k-del", "acct-3");
  assert.equal(getRoute("k-del"), "acct-3");
  deleteRoute("k-del");
  assert.equal(getRoute("k-del"), null);
});

test("_pruneNow clears stale entries", () => {
  _setTtlForTests(0);
  setRoute("k-stale", "acct-4");
  _pruneNow();
  assert.equal(getRoute("k-stale"), null);
  _setTtlForTests(2 * 60 * 60 * 1000);
});
