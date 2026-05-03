# Latency Percentile Trend Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-line chart on the dashboard overview showing p50 / p95 / p99 request latency over a 24h or 7d window, computed from `request_logs` rows where `status = 200`.

**Architecture:** Pure percentile math lives in a small new module so it can be unit-tested without SQLite. A new helper in `lib/db.js` queries `request_logs`, buckets rows in JS (15-min buckets for 24h, hourly for 7d), and applies the pure percentile function per bucket. A new Next.js API route exposes the result. The existing overview page gains one new card; the existing 3 KPI cards are untouched.

**Tech Stack:** Node 24, better-sqlite3, Next.js (App Router), React, recharts, Tailwind, shadcn/ui chart wrappers. Tests use `node:test` (zero deps; the existing pattern in `lib/*.test.js`).

**Spec:** `docs/superpowers/specs/2026-05-04-latency-percentiles-design.md`

---

## File Structure

**Create:**
- `lib/percentile.js` — pure helper: `pickPercentile(sortedAsc, p)`. No deps, no I/O.
- `lib/percentile.test.js` — unit tests for the pure helper.
- `next-app/app/api/stats/latency/route.ts` — GET handler, validates `period`, calls helper, returns JSON.

**Modify:**
- `lib/db.js` — add `getLatencyPercentiles(period)` that queries `request_logs`, buckets, calls `pickPercentile`, and returns the API shape.
- `lib/db.test.js` — add tests for `getLatencyPercentiles`.
- `next-app/app/dashboard/page.tsx` — add the latency card below the existing KPI row.

**No changes:** `lib/proxy.js`, `accountsStore.js`, schema. The existing `idx_timestamp` index on `request_logs` is reused.

---

## Task 1: Pure percentile helper

**Files:**
- Create: `lib/percentile.js`
- Test: `lib/percentile.test.js`

- [ ] **Step 1: Write failing tests**

Create `lib/percentile.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/percentile.test.js`

Expected: FAIL with `Cannot find module './percentile.js'` or similar.

- [ ] **Step 3: Implement `pickPercentile`**

Create `lib/percentile.js`:

```js
/**
 * Linear-interpolation percentile of a pre-sorted ascending numeric array.
 * Returns null for an empty input. Returns an integer (rounded) for non-empty.
 *
 * @param {number[]} sortedAsc  ascending-sorted values
 * @param {number} p            percentile in [0, 100]
 * @returns {number | null}
 */
export function pickPercentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const value = sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
  return Math.round(value);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/percentile.test.js`

Expected: 6 passing tests, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add lib/percentile.js lib/percentile.test.js
git commit -m "feat(stats): pure pickPercentile helper with linear interpolation"
```

---

## Task 2: `getLatencyPercentiles` DB helper

**Files:**
- Modify: `lib/db.js` (add new helper near `getStats`)
- Test: `lib/db.test.js` (extend existing file)

- [ ] **Step 1: Write failing tests**

Append to `lib/db.test.js` (after the existing tests, before/after still apply):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
const { getLatencyPercentiles, insertRequestLog, getDb } = await import("./db.js");

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
  // Insert one 200 and one 500 in the most recent bucket.
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
  // Drop 5 rows — all in the most recent bucket — with known latencies.
  const now = new Date().toISOString();
  for (const ms of [10, 20, 30, 40, 50]) {
    logLatency({ ts: now, status: 200, latency: ms });
  }
  const result = getLatencyPercentiles("24h");
  const last = result.points[result.points.length - 1];
  assert.equal(last.n, 5);
  assert.equal(last.p50, 30); // index 2 of 5 sorted
  assert.equal(last.p95, 48); // index 3.8 → 40 + 10*0.8
  assert.equal(last.p99, 50); // index 3.96 → 40 + 10*0.96 = 49.6 → 50
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/db.test.js`

Expected: the new tests FAIL with `getLatencyPercentiles is not a function` (or similar). The existing leaderboard tests should still pass.

- [ ] **Step 3: Implement `getLatencyPercentiles`**

Add to `lib/db.js`. Place near the other stats helpers, after `getStats` and before the usage section. Add the import at the top of the file (after the existing imports):

```js
import { pickPercentile } from "./percentile.js";
```

Then the helper itself:

```js
// ──────────────────────────────────────────────────────────────────
// Latency percentiles — backs the overview /api/stats/latency endpoint
// ──────────────────────────────────────────────────────────────────

const LATENCY_BUCKET_SECONDS = {
  "24h": 900,    // 15 min × 96 buckets
  "7d": 3600,    // 1 hour × 168 buckets
};

const LATENCY_WINDOW_HOURS = {
  "24h": 24,
  "7d": 24 * 7,
};

const VALID_LATENCY_PERIODS = new Set(["24h", "7d"]);

/**
 * Compute p50 / p95 / p99 latency over a rolling window, bucketed for charting.
 *
 * - Sample filter: status = 200 only (errors poison the distribution).
 * - Bucketing: 15-min buckets for 24h; 1-hour buckets for 7d.
 * - Empty buckets emit { p50: null, p95: null, p99: null, n: 0 } so the
 *   chart can render gaps.
 *
 * @param {"24h" | "7d" | string} period — invalid values fall back to "24h"
 * @returns {{ period: string, bucketSeconds: number, points: Array<{
 *   bucket: string, p50: number|null, p95: number|null, p99: number|null, n: number
 * }> }}
 */
export function getLatencyPercentiles(period = "24h") {
  if (!VALID_LATENCY_PERIODS.has(period)) period = "24h";
  const bucketSeconds = LATENCY_BUCKET_SECONDS[period];
  const bucketMs = bucketSeconds * 1000;
  const numBuckets = (LATENCY_WINDOW_HOURS[period] * 3600) / bucketSeconds;

  // The rightmost emitted bucket is the in-progress one (its start is the
  // bucket boundary just at or before "now"). The window therefore covers
  // (numBuckets - 1) completed buckets plus the in-progress one.
  const inProgressStart = Math.floor(Date.now() / bucketMs) * bucketMs;
  const startMs = inProgressStart - (numBuckets - 1) * bucketMs;
  const upperMs = inProgressStart + bucketMs; // exclusive — covers in-progress bucket
  const cutoffIso = new Date(startMs).toISOString();

  const database = getDb();
  const rows = database
    .prepare(`
      SELECT timestamp, latency_ms
      FROM request_logs
      WHERE status = 200 AND timestamp >= @cutoff
    `)
    .all({ cutoff: cutoffIso });

  // Group rows into bucket → array of latency_ms.
  const buckets = new Map();
  for (const r of rows) {
    if (r.latency_ms == null) continue;
    const ts = new Date(r.timestamp).getTime();
    if (!Number.isFinite(ts) || ts < startMs || ts >= upperMs) continue;
    const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
    let arr = buckets.get(bucketStart);
    if (!arr) { arr = []; buckets.set(bucketStart, arr); }
    arr.push(r.latency_ms);
  }

  // Emit one point per bucket: startMs, startMs+bucketMs, …, inProgressStart.
  const points = [];
  for (let b = startMs; b <= inProgressStart; b += bucketMs) {
    const arr = buckets.get(b) || [];
    arr.sort((x, y) => x - y);
    points.push({
      bucket: new Date(b).toISOString(),
      p50: pickPercentile(arr, 50),
      p95: pickPercentile(arr, 95),
      p99: pickPercentile(arr, 99),
      n: arr.length,
    });
  }

  return { period, bucketSeconds, points };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/db.test.js lib/percentile.test.js`

Expected: all tests pass — both the new latency tests and the existing leaderboard tests.

- [ ] **Step 5: Commit**

```bash
git add lib/db.js lib/db.test.js
git commit -m "feat(stats): getLatencyPercentiles bucketed over 24h/7d windows"
```

---

## Task 3: Next.js API route

**Files:**
- Create: `next-app/app/api/stats/latency/route.ts`

There is no Next.js test runner configured in this repo, so this task has no automated test. The helper covered by Task 2 is the unit-tested boundary; this route is thin glue. Manual verification happens in Task 5.

- [ ] **Step 1: Implement the route**

Create `next-app/app/api/stats/latency/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getLatencyPercentiles } from "@/lib/db";

const VALID_PERIODS = new Set(["24h", "7d"]);

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || "24h";
  if (!VALID_PERIODS.has(period)) {
    return NextResponse.json({ error: "Invalid period" }, { status: 400 });
  }
  const data = getLatencyPercentiles(period as "24h" | "7d");
  return NextResponse.json(data);
}
```

- [ ] **Step 2: Verify the route is reachable**

Start the dev server (in a separate shell that the user can run, or background it locally):

```bash
npm run dev
```

Then in a second shell:

```bash
curl -s 'http://localhost:3000/api/stats/latency?period=24h' | head -c 200
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:3000/api/stats/latency?period=bogus'
```

Expected:
- First call: a JSON response starting with `{"period":"24h","bucketSeconds":900,"points":[`.
- Second call: `400`.

If `npm run dev` is already running, you don't need to restart it — Next.js picks up new route files automatically.

- [ ] **Step 3: Commit**

```bash
git add next-app/app/api/stats/latency/route.ts
git commit -m "feat(api): GET /api/stats/latency for percentile chart"
```

---

## Task 4: Add the latency card to the overview page

**Files:**
- Modify: `next-app/app/dashboard/page.tsx`

This task has no automated test (no Next test rig). Verification is the manual smoke in Task 5.

- [ ] **Step 1: Replace the file**

Open `next-app/app/dashboard/page.tsx`. Replace its contents with:

```tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";

interface Stats {
  requestsToday: number;
  avgLatencyMs: number;
  errorCountToday: number;
}

interface Health {
  tokenExpiry: string | null;
  lastRefresh: string | null;
  status: "active" | "expiring-soon" | "expired";
}

type LatencyPeriod = "24h" | "7d";

interface LatencyPoint {
  bucket: string;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  n: number;
}

interface LatencyResponse {
  period: LatencyPeriod;
  bucketSeconds: number;
  points: LatencyPoint[];
}

const LATENCY_CHART_CONFIG: ChartConfig = {
  p50: { label: "p50", color: "var(--chart-1)" },
  p95: { label: "p95", color: "var(--chart-2)" },
  p99: { label: "p99", color: "var(--chart-5)" },
};

function formatBucket(iso: string, period: LatencyPeriod): string {
  const d = new Date(iso);
  if (period === "24h") {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric" });
}

export default function DashboardPage() {
  const { data: session } = useSession();
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch("/api/stats")
      .then((res) => res.json())
      .then(setStats)
      .catch(console.error);

    fetch("/api/health")
      .then((res) => res.json())
      .then(setHealth)
      .catch(console.error);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground">Welcome, {session?.user?.email}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Requests Today</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.requestsToday ?? "—"}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Avg Latency</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.avgLatencyMs ?? "—"} ms</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Token Status</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge
              variant={health?.status === "active" ? "default" : health?.status === "expiring-soon" ? "secondary" : "destructive"}
            >
              {health?.status ?? "unknown"}
            </Badge>
          </CardContent>
        </Card>
      </div>

      <LatencyCard />
    </div>
  );
}

function LatencyCard() {
  const [period, setPeriod] = useState<LatencyPeriod>("24h");
  const [data, setData] = useState<LatencyResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/stats/latency?period=${period}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((json: LatencyResponse) => { if (!cancelled) setData(json); })
      .catch(console.error)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period]);

  const chartData = useMemo(() => {
    if (!data) return [];
    return data.points.map((p) => ({
      label: formatBucket(p.bucket, data.period),
      p50: p.p50,
      p95: p.p95,
      p99: p.p99,
      n: p.n,
    }));
  }, [data]);

  const allEmpty = !!data && data.points.every((p) => p.n === 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div className="space-y-1">
          <CardTitle className="text-base">Latency</CardTitle>
          <p className="text-sm text-muted-foreground">p50 / p95 / p99 over time</p>
        </div>
        <div className="flex items-center gap-1 rounded-md bg-muted p-0.5">
          <PeriodButton active={period === "24h"} disabled={loading} onClick={() => setPeriod("24h")}>24h</PeriodButton>
          <PeriodButton active={period === "7d"} disabled={loading} onClick={() => setPeriod("7d")}>7d</PeriodButton>
        </div>
      </CardHeader>
      <CardContent>
        {!data ? (
          <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">Loading…</div>
        ) : allEmpty ? (
          <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
            No successful requests in this period
          </div>
        ) : (
          <ChartContainer config={LATENCY_CHART_CONFIG} className="aspect-auto h-64 w-full">
            <LineChart data={chartData} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeOpacity={0.2} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32} />
              <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(v) => `${v}ms`} />
              <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
              <Line dataKey="p50" type="monotone" stroke="var(--color-p50)" strokeWidth={2} dot={false} connectNulls={false} />
              <Line dataKey="p95" type="monotone" stroke="var(--color-p95)" strokeWidth={2} dot={false} connectNulls={false} />
              <Line dataKey="p99" type="monotone" stroke="var(--color-p99)" strokeWidth={2} dot={false} connectNulls={false} />
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function PeriodButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "px-3 py-1 rounded text-xs font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 2: Type-check the Next app**

Run: `npm -w next-app run build`

Expected: build succeeds. If TypeScript complains about the `chart-5` color token not being defined, fall back to `--chart-3` for `p99` (re-run the build after the edit). The shadcn theme exposes `--chart-1` through `--chart-5` by default; one or the other will exist in this repo's CSS.

If the build complains about anything else, fix it before moving on.

- [ ] **Step 3: Commit**

```bash
git add next-app/app/dashboard/page.tsx
git commit -m "feat(dashboard): latency p50/p95/p99 trend chart on overview"
```

---

## Task 5: Manual UI smoke test

**Files:** none — visual / behavioral verification only.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

Wait for both the proxy (`blue`) and Next dashboard (`green`) lines to print "ready" / "Local: http://localhost:3000".

- [ ] **Step 2: Open the dashboard and log in**

Navigate to `http://localhost:3000/dashboard` in a browser and sign in if prompted.

Expected: page renders with the 3 existing KPI cards on top, then a single full-width "Latency" card below them.

- [ ] **Step 3: Inspect the chart at 24h**

The card title reads `Latency`, subtitle `p50 / p95 / p99 over time`. The toggle in the header shows `24h` (highlighted) and `7d`.

The chart should render three lines (p50/p95/p99) with the existing recent-request data. Empty buckets (idle stretches) should appear as gaps in the lines, not zero-floored lines. Hovering shows a tooltip with all three percentiles.

If the database has no `status = 200` rows in the last 24h, the card body shows the centered "No successful requests in this period" message instead of a chart. Issue some real requests (e.g., one curl through the proxy) and refresh — the chart should populate.

- [ ] **Step 4: Toggle to 7d**

Click the `7d` button in the card header.

Expected: the chart re-fetches and re-renders against a 7-day window with hourly buckets. The button highlight moves to `7d`. Toggling back to `24h` returns to 15-min buckets.

- [ ] **Step 5: Verify the existing KPIs were not disturbed**

The 3 top cards should still show the same values they did before this change. The sidebar should be untouched. Other dashboard pages (`/dashboard/usage`, `/dashboard/logs`, etc.) should still load normally.

- [ ] **Step 6: If anything looked wrong, fix and re-commit**

If the chart renders but a polish issue is visible (color clash, x-axis overcrowding, tooltip layout), fix it directly in `next-app/app/dashboard/page.tsx` and commit:

```bash
git add next-app/app/dashboard/page.tsx
git commit -m "fix(dashboard): polish latency chart <specific fix>"
```

If functionality is broken (chart doesn't render, fetch errors, type errors), do not paper over it — investigate the root cause via the proxy/dev console and fix the underlying issue.

---

## Self-review notes

- Spec coverage: every section of the spec maps to a task. Sample filter (`status = 200`), rolling 24h vs calendar-day, 96/168 bucket counts, null percentiles for empty buckets, no period polling, "below the existing KPI row" placement, and the explicit relationship-to-existing-KPI note are all reflected in Tasks 2 and 4.
- No placeholders: every code step ships full code. Tests have concrete asserts with computed expected values.
- Type consistency: `LatencyResponse` / `LatencyPoint` shape on the frontend matches the JSON shape returned by `getLatencyPercentiles` in `lib/db.js`. `period` is the same union (`"24h" | "7d"`) on both ends. The API route validates and narrows.
- Out-of-scope items from the spec (per-model breakdown, 30d, alerting) are not implemented. Confirmed by reading the file list — only the four files listed change.
