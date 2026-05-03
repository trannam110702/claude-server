import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPercentile } from "./percentile.js";

test("pickPercentile returns null for empty array", () => {
  assert.equal(pickPercentile([], 50), null);
  assert.equal(pickPercentile([], 99), null);
});

test("pickPercentile returns the only value for single-element array", () => {
  assert.equal(pickPercentile([42], 50), 42);
  assert.equal(pickPercentile([42], 99), 42);
  assert.equal(pickPercentile([42], 0), 42);
});

test("pickPercentile returns the median for an odd-length sorted array", () => {
  // index = 0.5 * (5 - 1) = 2 → sorted[2] = 30
  assert.equal(pickPercentile([10, 20, 30, 40, 50], 50), 30);
});

test("pickPercentile linearly interpolates between adjacent points", () => {
  // p50 of [10, 20]: index = 0.5 * 1 = 0.5 → 10 + (20-10)*0.5 = 15
  assert.equal(pickPercentile([10, 20], 50), 15);
  // p95 of [10, 20, 30, 40, 50]: index = 0.95 * 4 = 3.8 → 40 + 10*0.8 = 48
  assert.equal(pickPercentile([10, 20, 30, 40, 50], 95), 48);
});

test("pickPercentile handles 0 and 100 boundaries", () => {
  assert.equal(pickPercentile([10, 20, 30], 0), 10);
  assert.equal(pickPercentile([10, 20, 30], 100), 30);
});

test("pickPercentile rounds to integer ms", () => {
  // p99 of [10, 20]: index = 0.99 * 1 = 0.99 → 10 + 10*0.99 = 19.9 → 20
  assert.equal(pickPercentile([10, 20], 99), 20);
  // p25 of [0, 1, 2, 3]: index = 0.25 * 3 = 0.75 → 0 + 1*0.75 = 0.75 → 1
  assert.equal(pickPercentile([0, 1, 2, 3], 25), 1);
});
