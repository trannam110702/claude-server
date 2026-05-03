# Per-user leaderboard + sticky account routing — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public leaderboard of top token consumers and re-architect Claude account selection to pin a conversation to one account (preserving prompt cache), with 9router-style fallback (per-(account, model) locks, exponential backoff, retry-after parsing).

**Architecture:** Phase 1 (leaderboard) is a thin SQL aggregate + new API route + page — no proxy changes. Phase 2 splits responsibility into four new modules: `accountFallback.js` (pure helpers ported from 9router), `sessionRoutes.js` (in-memory map with TTL), `sessionKey.js` (layered identifier strategy), plus modifications to `accountsStore.js` (atomic pick with lock filter) and `proxy.js` (retry loop with `excludeIds`, `preferredAccountId`, retry-after parsing).

**Tech Stack:** Node 20+ (stdlib `node:test`, `crypto`), better-sqlite3, lowdb, proper-lockfile, Next.js 15, TypeScript, recharts, lucide-react, @anthropic-ai/sdk.

**Spec:** `docs/superpowers/specs/2026-05-04-per-user-usage-and-sticky-routing-design.md`

---

## File map

**New files**
- `lib/accountFallback.js` — constants, `ERROR_RULES`, `checkFallbackError`, model-lock helpers, `formatRetryAfter`
- `lib/accountFallback.test.js` — unit tests (node:test)
- `lib/sessionRoutes.js` — in-memory `Map<sessionKey, {accountId, lastSeen}>` with TTL
- `lib/sessionRoutes.test.js`
- `lib/sessionKey.js` — `computeSessionKey(headers, body, userTokenId)` layered strategy + `firstMessageHash`
- `lib/sessionKey.test.js`
- `lib/requestInspector.js` — opt-in (`INSPECT_REQUESTS=N`) one-shot logger
- `next-app/app/api/usage/leaderboard/route.ts`
- `next-app/app/dashboard/leaderboard/page.tsx`

**Modified files**
- `lib/db.js` — add `queryLeaderboard(period, sort)`
- `lib/db.test.js` — new file, tests `queryLeaderboard`
- `lib/accountsStore.js` — add `updateAccountFlags`, refactor `pickActiveAccount` to options object + lock filter + atomic LRU update, add `markAccountUnavailable`, `clearAccountError`, surface lock state via `listAccounts` (already returns full record — caller can read flat fields)
- `lib/accountsStore.test.js` — new file, tests new functions
- `lib/proxy.js` — compute `sessionKey` per request, refactor `runWithFailover` for new pick API + retry loop + retry-after parse, plug in `requestInspector`
- `next-app/lib/db.ts` — re-export new functions
- `next-app/app/api/claude/accounts/route.ts` — extend `redact` to include lock state
- `next-app/app/dashboard/accounts/page.tsx` — show lock countdown per account
- `next-app/app/dashboard/components/Sidebar.tsx` — add Leaderboard nav entry
- `package.json` — add `"test": "node --test lib/*.test.js"` script

---

## Phase 1 — Leaderboard

### Task 1: Add `queryLeaderboard` to `lib/db.js` with tests

**Files:**
- Create: `lib/db.test.js`
- Modify: `lib/db.js`

- [ ] **Step 1: Write the failing test**

Create `lib/db.test.js`:
```js
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
  // Insert an old log
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/db.test.js`
Expected: FAIL with `queryLeaderboard is not exported` or similar.

- [ ] **Step 3: Implement `queryLeaderboard` in `lib/db.js`**

Add after `getUsageStats` (around line 273):
```js
const VALID_LEADERBOARD_SORTS = new Set(["total_tokens", "requests"]);

export function queryLeaderboard(period = "7d", sort = "total_tokens") {
  if (!VALID_LEADERBOARD_SORTS.has(sort)) sort = "total_tokens";
  const database = getDb();
  const hours = PERIOD_HOURS[period];
  const cutoffIso = hours
    ? new Date(Date.now() - hours * 3_600_000).toISOString()
    : null;

  const where = cutoffIso
    ? "user_email IS NOT NULL AND timestamp >= @cutoff"
    : "user_email IS NOT NULL";
  const params = cutoffIso ? { cutoff: cutoffIso } : {};

  const orderBy = sort === "requests" ? "requests DESC" : "total_tokens DESC";

  const rows = database
    .prepare(`
      SELECT
        user_email,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS total_tokens,
        MAX(timestamp) AS last_active
      FROM request_logs
      WHERE ${where}
      GROUP BY user_email
      ORDER BY ${orderBy}
      LIMIT 100
    `)
    .all(params);

  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/db.test.js`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/db.js lib/db.test.js
git commit -m "feat(db): add queryLeaderboard for per-user usage aggregation"
```

---

### Task 2: Add `npm test` script and re-export `queryLeaderboard` from Next.js side

**Files:**
- Modify: `package.json`
- Modify: `next-app/lib/db.ts`

- [ ] **Step 1: Add test script to `package.json`**

Edit the `scripts` object — add the line after `test:refresh`:
```json
"test": "node --test lib/*.test.js"
```

- [ ] **Step 2: Run `npm test`**

Run: `npm test`
Expected: 4 tests PASS (only db tests exist so far).

- [ ] **Step 3: Re-export `queryLeaderboard` in `next-app/lib/db.ts`**

In `next-app/lib/db.ts`, extend the first re-export block (line 5-11):
```ts
export {
  getDb,
  insertRequestLog,
  queryLogs,
  getStats,
  getUsageStats,
  queryLeaderboard,
} from "../../lib/db.js";
```

- [ ] **Step 4: Verify Next.js typechecks**

Run: `npm -w next-app run build`
Expected: Build succeeds (no new errors).

- [ ] **Step 5: Commit**

```bash
git add package.json next-app/lib/db.ts
git commit -m "chore: wire npm test, expose queryLeaderboard to next-app"
```

---

### Task 3: Create `/api/usage/leaderboard` route

**Files:**
- Create: `next-app/app/api/usage/leaderboard/route.ts`

- [ ] **Step 1: Write the route file**

```ts
import { NextResponse } from "next/server";
import { queryLeaderboard } from "@/lib/db";

const VALID_PERIODS = new Set(["24h", "7d", "30d", "all"]);
const VALID_SORTS = new Set(["total_tokens", "requests"]);

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || "7d";
  const sort = searchParams.get("sort") || "total_tokens";

  if (!VALID_PERIODS.has(period)) {
    return NextResponse.json({ error: "Invalid period" }, { status: 400 });
  }
  if (!VALID_SORTS.has(sort)) {
    return NextResponse.json({ error: "Invalid sort" }, { status: 400 });
  }

  const rows = queryLeaderboard(
    period as "24h" | "7d" | "30d" | "all",
    sort as "total_tokens" | "requests"
  );

  return NextResponse.json({ period, sort, rows });
}
```

- [ ] **Step 2: Verify route returns expected shape**

Start the dev server: `npm run dev`
Curl: `curl 'http://localhost:3000/api/usage/leaderboard?period=all&sort=total_tokens' -H 'Cookie: <session cookie>'`
Expected: `{"period":"all","sort":"total_tokens","rows":[...]}` — the rows reflect whatever's currently in `request_logs`.

- [ ] **Step 3: Commit**

```bash
git add next-app/app/api/usage/leaderboard/route.ts
git commit -m "feat(api): add /api/usage/leaderboard"
```

---

### Task 4: Create `/dashboard/leaderboard` page

**Files:**
- Create: `next-app/app/dashboard/leaderboard/page.tsx`

- [ ] **Step 1: Write the page**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { Medal, RefreshCw } from "lucide-react";

const PERIODS = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
] as const;
type Period = (typeof PERIODS)[number]["value"];

const SORTS = [
  { value: "total_tokens", label: "By total tokens" },
  { value: "requests", label: "By requests" },
] as const;
type Sort = (typeof SORTS)[number]["value"];

interface Row {
  user_email: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  last_active: string;
}

interface LeaderboardResponse {
  period: Period;
  sort: Sort;
  rows: Row[];
}

const fmtNum = (n: number | null | undefined) =>
  n == null ? "0" : n.toLocaleString();

function relative(time: string | null) {
  if (!time) return "—";
  const diff = Date.now() - new Date(time).getTime();
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

const MEDAL_TONE = [
  "text-yellow-500",   // 1st
  "text-zinc-400",     // 2nd
  "text-amber-700",    // 3rd
];

export default function LeaderboardPage() {
  const [period, setPeriod] = useState<Period>("7d");
  const [sort, setSort] = useState<Sort>("total_tokens");
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (p: Period, s: Sort) => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/usage/leaderboard?period=${p}&sort=${s}`,
        { cache: "no-store" }
      );
      const json = await res.json();
      setData(json);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(period, sort);
  }, [period, sort, load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Leaderboard</h1>
          <p className="text-sm text-muted-foreground">
            Top token consumers across all registered users.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Pill
            options={PERIODS}
            value={period}
            onChange={(v) => setPeriod(v as Period)}
            disabled={loading}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => load(period, sort)}
            disabled={loading}
          >
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <div className="space-y-1">
            <CardTitle className="text-base">Ranking</CardTitle>
            <CardDescription>
              {data?.rows?.length ?? 0} user{data?.rows?.length === 1 ? "" : "s"}
            </CardDescription>
          </div>
          <Pill
            options={SORTS}
            value={sort}
            onChange={(v) => setSort(v as Sort)}
            disabled={loading}
          />
        </CardHeader>
        <CardContent>
          {data === null ? (
            <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
          ) : data.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No usage data for this period.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Input</TableHead>
                  <TableHead className="text-right">Output</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Last active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r, i) => (
                  <TableRow key={r.user_email}>
                    <TableCell className="font-medium">
                      {i < 3 ? (
                        <span className="inline-flex items-center gap-1">
                          <Medal className={cn("h-4 w-4", MEDAL_TONE[i])} />
                          {i + 1}
                        </span>
                      ) : (
                        i + 1
                      )}
                    </TableCell>
                    <TableCell className="font-medium">{r.user_email}</TableCell>
                    <TableCell className={cn(
                      "text-right tabular-nums",
                      sort === "requests" && "font-semibold"
                    )}>
                      {fmtNum(r.requests)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(r.input_tokens)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(r.output_tokens)}</TableCell>
                    <TableCell className={cn(
                      "text-right tabular-nums",
                      sort === "total_tokens" && "font-semibold"
                    )}>
                      {fmtNum(r.total_tokens)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {relative(r.last_active)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Pill<T extends { value: string; label: string }>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: readonly T[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1 rounded-md bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            "px-3 py-1 rounded text-xs font-medium transition-colors",
            value === o.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Visual verification**

With `npm run dev` running, open `http://localhost:3000/dashboard/leaderboard` (sign in if needed). Verify:
- Page renders with period selector + sort toggle
- "No usage data" empty state if request_logs is empty
- If there's data: rows render, top 3 show medal icon, sorted column is bold
- Clicking sort/period reloads
- Refresh button spins while loading

- [ ] **Step 3: Commit**

```bash
git add next-app/app/dashboard/leaderboard/page.tsx
git commit -m "feat(dashboard): add leaderboard page"
```

---

### Task 5: Add Leaderboard to Sidebar nav

**Files:**
- Modify: `next-app/app/dashboard/components/Sidebar.tsx`

- [ ] **Step 1: Modify the navItems array**

In `next-app/app/dashboard/components/Sidebar.tsx`, line 5 — extend the lucide-react import:
```tsx
import { Home, BarChart3, FileText, HeartPulse, KeyRound, LogOut, Users, Trophy } from "lucide-react";
```

Replace the `navItems` array (lines 12-19) with:
```tsx
const navItems = [
  { href: "/dashboard", label: "Overview", icon: Home },
  { href: "/dashboard/accounts", label: "Accounts", icon: Users },
  { href: "/dashboard/tokens", label: "API tokens", icon: KeyRound },
  { href: "/dashboard/usage", label: "Usage", icon: BarChart3 },
  { href: "/dashboard/leaderboard", label: "Leaderboard", icon: Trophy },
  { href: "/dashboard/logs", label: "Logs", icon: FileText },
  { href: "/dashboard/health", label: "Health", icon: HeartPulse },
];
```

- [ ] **Step 2: Visual verification**

With dev server running, reload any dashboard page. Verify Leaderboard entry appears between Usage and Logs with the Trophy icon, links to `/dashboard/leaderboard`, highlights when active.

- [ ] **Step 3: Commit**

```bash
git add next-app/app/dashboard/components/Sidebar.tsx
git commit -m "feat(dashboard): add Leaderboard to sidebar"
```

**Phase 1 complete.** Leaderboard ships independently here.

---

## Phase 2 — Sticky routing + fallback

### Task 6: Create `lib/accountFallback.js` with full unit tests

**Files:**
- Create: `lib/accountFallback.js`
- Create: `lib/accountFallback.test.js`

- [ ] **Step 1: Write the failing tests**

Create `lib/accountFallback.test.js`:
```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/accountFallback.test.js`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `lib/accountFallback.js`**

Create the file:
```js
/**
 * Account fallback helpers — adapted from 9router's accountFallback.js.
 *
 * Centralizes:
 * - ERROR_RULES table mapping (status, errorText) → fallback decision
 * - Per-(account, model) lock helpers using flat `modelLock_<model>` fields
 * - Exponential backoff for rate-limit errors
 * - Human-readable retry-after formatting
 */

export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15,
};

export const TRANSIENT_COOLDOWN_MS = 30 * 1000;
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

export const MODEL_LOCK_PREFIX = "modelLock_";
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

export const ERROR_RULES = [
  // Text-based rules (checked first, top-to-bottom)
  { text: "no credentials",            cooldownMs: COOLDOWN.long },
  { text: "request not allowed",       cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "rate limit",                backoff: true },
  { text: "too many requests",         backoff: true },
  { text: "quota exceeded",            backoff: true },
  { text: "capacity",                  backoff: true },
  { text: "overloaded",                backoff: true },
  // Status-based rules (fallback when text doesn't match)
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

export function getQuotaCooldown(backoffLevel = 0) {
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = BACKOFF_CONFIG.base * Math.pow(2, level);
  return Math.min(cooldown, BACKOFF_CONFIG.max);
}

export function checkFallbackError(status, errorText, backoffLevel = 0) {
  const lowerError = errorText
    ? (typeof errorText === "string" ? errorText : JSON.stringify(errorText)).toLowerCase()
    : "";

  for (const rule of ERROR_RULES) {
    if (rule.text && lowerError && lowerError.includes(rule.text)) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }
    if (rule.status && rule.status === status) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }
  }

  return { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS };
}

export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

export function isModelLockActive(account, model) {
  const key = getModelLockKey(model);
  const expiry = account[key] || account[MODEL_LOCK_ALL];
  if (!expiry) return false;
  return new Date(expiry).getTime() > Date.now();
}

export function getEarliestModelLockUntil(account) {
  if (!account) return null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(account)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

export function buildModelLockUpdate(model, cooldownMs) {
  const key = getModelLockKey(model);
  return { [key]: new Date(Date.now() + cooldownMs).toISOString() };
}

export function buildClearModelLocksUpdate(account) {
  const cleared = {};
  for (const key of Object.keys(account)) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/accountFallback.test.js`
Expected: 12 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/accountFallback.js lib/accountFallback.test.js
git commit -m "feat(fallback): port accountFallback helpers from 9router"
```

---

### Task 7: Create `lib/sessionRoutes.js` with tests

**Files:**
- Create: `lib/sessionRoutes.js`
- Create: `lib/sessionRoutes.test.js`

- [ ] **Step 1: Write the failing test**

Create `lib/sessionRoutes.test.js`:
```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/sessionRoutes.test.js`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `lib/sessionRoutes.js`**

```js
/**
 * Session → account pin store.
 *
 * In-memory only. On proxy restart, all sessions re-pin on their next request
 * (one cache miss per active conversation, then back to sticky).
 *
 * Each entry has a sliding TTL: getRoute on a hit refreshes lastSeen, so
 * active conversations never expire mid-flight.
 */

const routes = new Map();

let TTL_MS = 2 * 60 * 60 * 1000;
const PRUNE_MS = 10 * 60 * 1000;

export function getRoute(sessionKey) {
  if (!sessionKey) return null;
  const r = routes.get(sessionKey);
  if (!r) return null;
  if (Date.now() - r.lastSeen > TTL_MS) {
    routes.delete(sessionKey);
    return null;
  }
  r.lastSeen = Date.now();
  return r.accountId;
}

export function setRoute(sessionKey, accountId) {
  if (!sessionKey || !accountId) return;
  routes.set(sessionKey, { accountId, lastSeen: Date.now() });
}

export function deleteRoute(sessionKey) {
  if (sessionKey) routes.delete(sessionKey);
}

export function _pruneNow() {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of routes) if (v.lastSeen < cutoff) routes.delete(k);
}

// Test hook
export function _setTtlForTests(ms) {
  TTL_MS = ms;
}

setInterval(_pruneNow, PRUNE_MS).unref();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/sessionRoutes.test.js`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/sessionRoutes.js lib/sessionRoutes.test.js
git commit -m "feat(routing): add in-memory sessionRoutes store with TTL"
```

---

### Task 8: Create `lib/sessionKey.js` with tests

**Files:**
- Create: `lib/sessionKey.js`
- Create: `lib/sessionKey.test.js`

- [ ] **Step 1: Write the failing test**

Create `lib/sessionKey.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSessionKey, firstMessageHash } from "./sessionKey.js";

const baseBody = { messages: [{ role: "user", content: "hello" }] };

test("computeSessionKey returns null without userTokenId", () => {
  assert.equal(computeSessionKey({}, baseBody, null), null);
  assert.equal(computeSessionKey({}, baseBody, ""), null);
});

test("computeSessionKey prefers x-claude-session-id header", () => {
  const k = computeSessionKey(
    { "x-claude-session-id": "sess-A", "anthropic-conversation-id": "conv-B" },
    { metadata: { user_id: "U" }, ...baseBody },
    "tok-1"
  );
  assert.equal(k, "tok-1:sess-A");
});

test("computeSessionKey prefers anthropic-conversation-id over metadata", () => {
  const k = computeSessionKey(
    { "anthropic-conversation-id": "conv-B" },
    { metadata: { user_id: "U" }, ...baseBody },
    "tok-1"
  );
  assert.equal(k, "tok-1:conv-B");
});

test("computeSessionKey prefers metadata.session_id over user_id", () => {
  const k = computeSessionKey(
    {},
    { metadata: { session_id: "S", user_id: "U" }, ...baseBody },
    "tok-1"
  );
  assert.equal(k, "tok-1:S");
});

test("computeSessionKey uses metadata.user_id when no session candidates", () => {
  const k = computeSessionKey(
    {},
    { metadata: { user_id: "U" }, ...baseBody },
    "tok-1"
  );
  assert.equal(k, "tok-1:U");
});

test("computeSessionKey falls back to firstMessageHash", () => {
  const k = computeSessionKey({}, baseBody, "tok-1");
  const h = firstMessageHash(baseBody);
  assert.equal(k, `tok-1:${h}`);
  assert.match(h, /^[0-9a-f]{16}$/);
});

test("computeSessionKey returns null when no candidates and no messages", () => {
  assert.equal(computeSessionKey({}, {}, "tok-1"), null);
  assert.equal(computeSessionKey({}, { messages: [] }, "tok-1"), null);
});

test("firstMessageHash is stable for the same first message", () => {
  const a = firstMessageHash({ messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }] });
  const b = firstMessageHash({ messages: [{ role: "user", content: "x" }] });
  assert.equal(a, b);
});

test("firstMessageHash differs for different first messages", () => {
  const a = firstMessageHash({ messages: [{ role: "user", content: "hello" }] });
  const b = firstMessageHash({ messages: [{ role: "user", content: "hi" }] });
  assert.notEqual(a, b);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/sessionKey.test.js`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `lib/sessionKey.js`**

```js
/**
 * Compute a session key for sticky account routing.
 *
 * Layered candidate strategy: prefer official identifiers over content-hash.
 * The exact identifiers Claude Code CLI emits are not yet confirmed; the
 * INSPECT_REQUESTS env var enables one-shot logging of real requests so the
 * candidate list can be trimmed once we have evidence.
 */
import crypto from "node:crypto";

export function firstMessageHash(body) {
  const m = body?.messages?.[0];
  if (!m) return null;
  return crypto.createHash("sha256").update(JSON.stringify(m)).digest("hex").slice(0, 16);
}

export function computeSessionKey(headers = {}, body = {}, userTokenId) {
  if (!userTokenId) return null;
  const candidates = [
    headers["x-claude-session-id"],          // probe — verify with inspector
    headers["anthropic-conversation-id"],    // probe — verify with inspector
    body?.metadata?.session_id,              // probe — verify with inspector
    body?.metadata?.user_id,                 // documented Anthropic field
    firstMessageHash(body),                  // content-based fallback
  ];
  for (const c of candidates) if (c) return `${userTokenId}:${c}`;
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/sessionKey.test.js`
Expected: 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/sessionKey.js lib/sessionKey.test.js
git commit -m "feat(routing): add layered session-key derivation"
```

---

### Task 9: Add `updateAccountFlags` helper and refactor `pickActiveAccount`

**Files:**
- Modify: `lib/accountsStore.js`
- Create: `lib/accountsStore.test.js`

- [ ] **Step 1: Write the failing test**

Create `lib/accountsStore.test.js`:
```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/accountsStore.test.js`
Expected: FAIL — `pickActiveAccount` doesn't accept options object, `updateAccountFlags` doesn't exist.

- [ ] **Step 3: Refactor `pickActiveAccount` and add `updateAccountFlags`**

In `lib/accountsStore.js`:

Add this import near the other imports at the top (around line 16):
```js
import {
  isModelLockActive,
  getEarliestModelLockUntil,
  formatRetryAfter,
} from "./accountFallback.js";
```

Replace the existing `pickActiveAccount` function (lines 285-310) with:
```js
/**
 * Pick an active Claude account.
 *
 * @param {object} opts
 * @param {Set<string>|string[]} [opts.excludeIds]   Account IDs that already failed in this request
 * @param {string|null}          [opts.model]        Model name; pick filters out accounts whose modelLock_<model> is active
 * @param {string|null}          [opts.preferredAccountId]  Sticky pin — prefer this account if eligible
 *
 * @returns {Promise<
 *   ClaudeAccount
 *   | { allLocked: true, retryAfter: string, retryAfterHuman: string, lastError: string|null, lastErrorCode: number|null }
 *   | null
 * >}
 */
export async function pickActiveAccount(opts = {}) {
  const excludeSet = opts.excludeIds instanceof Set
    ? opts.excludeIds
    : (Array.isArray(opts.excludeIds) ? new Set(opts.excludeIds) : new Set());
  const model = opts.model ?? null;
  const preferredAccountId = opts.preferredAccountId ?? null;

  return mutate((data) => {
    const allActive = data.accounts.filter((a) => a.isActive);
    if (!allActive.length) return null;

    const eligible = allActive.filter((a) => !excludeSet.has(a.id) && !isModelLockActive(a, model));

    if (!eligible.length) {
      const lockedForModel = allActive.filter((a) => isModelLockActive(a, model));
      if (lockedForModel.length) {
        const expiries = lockedForModel
          .map((a) => getEarliestModelLockUntil(a))
          .filter(Boolean)
          .sort();
        const earliest = expiries[0] || null;
        const worst = lockedForModel.find((a) => a.errorCode || a.lastError) || lockedForModel[0];
        return {
          allLocked: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: worst?.lastError ?? null,
          lastErrorCode: worst?.errorCode ?? null,
        };
      }
      return null;
    }

    let chosen = null;
    if (preferredAccountId) {
      chosen = eligible.find((a) => a.id === preferredAccountId) || null;
    }
    if (!chosen) {
      const sorted = [...eligible].sort((x, y) => {
        const xt = x.lastUsedAt ? new Date(x.lastUsedAt).getTime() : 0;
        const yt = y.lastUsedAt ? new Date(y.lastUsedAt).getTime() : 0;
        if (xt !== yt) return xt - yt;
        return new Date(x.createdAt).getTime() - new Date(y.createdAt).getTime();
      });
      chosen = sorted[0];
    }

    const now = new Date().toISOString();
    chosen.lastUsedAt = now;
    chosen.updatedAt = now;
    return { ...chosen };
  });
}
```

Add `updateAccountFlags` after `markAccountError` (around line 348):
```js
const ALLOWED_FLAG_KEYS = new Set([
  "lastUsedAt",
  "lastError",
  "lastErrorAt",
  "errorCode",
  "backoffLevel",
]);

/**
 * Update flat per-account fields used by the fallback subsystem.
 *
 * Permits the fixed-name flags above plus any `modelLock_*` key. Any other
 * key in `flags` is ignored — keeps the public schema explicit.
 */
export async function updateAccountFlags(id, flags) {
  await mutate((data) => {
    const account = data.accounts.find((a) => a.id === id);
    if (!account) return;
    for (const [k, v] of Object.entries(flags)) {
      if (k.startsWith("modelLock_") || ALLOWED_FLAG_KEYS.has(k)) {
        account[k] = v;
      }
    }
    account.updatedAt = new Date().toISOString();
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/accountsStore.test.js`
Expected: 7 tests PASS.

- [ ] **Step 5: Run all tests so far**

Run: `npm test`
Expected: db + accountFallback + sessionRoutes + sessionKey + accountsStore tests all PASS.

- [ ] **Step 6: Update `pickActiveAccount` callers**

`lib/proxy.js` line 94 currently calls `pickActiveAccount(excludeIds)` (array). Update to `pickActiveAccount({ excludeIds })`. This keeps the existing failover loop temporarily working (Task 13 replaces it entirely).

Edit `lib/proxy.js` `acquireAccount` function:
```js
async function acquireAccount(config, excludeIds = []) {
  let account = await pickActiveAccount({ excludeIds });
  if (!account) return null;
  if (account.allLocked) return null;
  account = await ensureFreshAccount(account);
  await markAccountUsed(account.id);
  return { account, client: createClient(config, account.accessToken) };
}
```

- [ ] **Step 7: Smoke check existing flow still works**

Run: `npm run dev`
Make a request through the proxy with a known-valid configuration. Verify:
- Proxy still forwards to Claude
- `request_logs` still records
- No new errors in console

- [ ] **Step 8: Commit**

```bash
git add lib/accountsStore.js lib/accountsStore.test.js lib/proxy.js
git commit -m "refactor(accounts): pickActiveAccount takes options, add updateAccountFlags

- Options object: { excludeIds, model, preferredAccountId }
- Atomic LRU update (single mutate call)
- Filters out accounts whose modelLock_<model> is active
- Returns {allLocked, retryAfter, ...} when every eligible account is locked
- updateAccountFlags helper writes modelLock_* + backoff/error fields
"
```

---

### Task 10: Add `markAccountUnavailable` and `clearAccountError` to `accountsStore.js`

**Files:**
- Modify: `lib/accountsStore.js`
- Modify: `lib/accountsStore.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `lib/accountsStore.test.js`:
```js
test("markAccountUnavailable on 401 sets long cooldown, no backoff increment", async () => {
  const a = await freshAcct("err1");
  const before = (await listAccounts()).find((x) => x.id === a.id);
  assert.equal(before.backoffLevel ?? 0, 0);

  const { markAccountUnavailable } = await import("./accountsStore.js");
  const r = await markAccountUnavailable(a.id, 401, "Unauthorized", "sonnet");
  assert.equal(r.shouldFallback, true);
  assert.ok(r.cooldownMs >= 60_000);

  const after = (await listAccounts()).find((x) => x.id === a.id);
  assert.equal(after.errorCode, 401);
  assert.equal(after.lastError, "Unauthorized");
  assert.ok(after.modelLock_sonnet);
  assert.equal(after.backoffLevel ?? 0, 0);
});

test("markAccountUnavailable on 429 increments backoffLevel", async () => {
  const a = await freshAcct("err2");
  const { markAccountUnavailable } = await import("./accountsStore.js");
  await markAccountUnavailable(a.id, 429, "rate limit reached", "sonnet");
  const after1 = (await listAccounts()).find((x) => x.id === a.id);
  assert.equal(after1.backoffLevel, 1);
  await markAccountUnavailable(a.id, 429, "rate limit reached", "sonnet");
  const after2 = (await listAccounts()).find((x) => x.id === a.id);
  assert.equal(after2.backoffLevel, 2);
});

test("markAccountUnavailable with resetsAtMs overrides backoff", async () => {
  const a = await freshAcct("err3");
  const { markAccountUnavailable } = await import("./accountsStore.js");
  const resetsAt = Date.now() + 60_000;
  const r = await markAccountUnavailable(a.id, 429, "rate limit", "sonnet", resetsAt);
  assert.equal(r.shouldFallback, true);
  assert.ok(r.cooldownMs >= 59_000 && r.cooldownMs <= 61_000);
  const after = (await listAccounts()).find((x) => x.id === a.id);
  // resetsAt path resets backoff to 0
  assert.equal(after.backoffLevel ?? 0, 0);
});

test("clearAccountError on success nulls model lock, resets state when no other locks", async () => {
  const a = await freshAcct("ok1");
  const { markAccountUnavailable, clearAccountError } = await import("./accountsStore.js");
  await markAccountUnavailable(a.id, 429, "rate limit", "sonnet");
  await clearAccountError(a.id, "sonnet");
  const after = (await listAccounts()).find((x) => x.id === a.id);
  assert.equal(after.modelLock_sonnet ?? null, null);
  assert.equal(after.lastError, null);
  assert.equal(after.errorCode, null);
  assert.equal(after.backoffLevel, 0);
});

test("clearAccountError preserves still-active locks for other models", async () => {
  const a = await freshAcct("ok2");
  const { markAccountUnavailable, clearAccountError } = await import("./accountsStore.js");
  await markAccountUnavailable(a.id, 429, "rate limit", "sonnet");
  await markAccountUnavailable(a.id, 429, "rate limit", "haiku");
  await clearAccountError(a.id, "sonnet");
  const after = (await listAccounts()).find((x) => x.id === a.id);
  assert.equal(after.modelLock_sonnet ?? null, null);
  assert.ok(after.modelLock_haiku); // still active
  // backoff retained because another lock still active
  assert.notEqual(after.backoffLevel, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/accountsStore.test.js`
Expected: New tests FAIL — `markAccountUnavailable` and `clearAccountError` don't exist.

- [ ] **Step 3: Implement both functions**

In `lib/accountsStore.js`, extend the imports from `./accountFallback.js`:
```js
import {
  isModelLockActive,
  getEarliestModelLockUntil,
  formatRetryAfter,
  checkFallbackError,
  buildModelLockUpdate,
  MODEL_LOCK_PREFIX,
  MODEL_LOCK_ALL,
  MAX_RATE_LIMIT_COOLDOWN_MS,
} from "./accountFallback.js";
```

Add the two new functions after `updateAccountFlags`:
```js
/**
 * Mark an account unavailable for the given model after an upstream error.
 *
 * - Computes cooldown via checkFallbackError, unless `resetsAtMs` is provided
 *   (precise upstream signal — overrides exponential backoff)
 * - Writes `modelLock_<model>` (or `modelLock___all` if `model` is null)
 * - Updates backoff state, lastError, errorCode, lastErrorAt
 *
 * @returns {Promise<{ shouldFallback: boolean, cooldownMs: number }>}
 */
export async function markAccountUnavailable(id, status, errText, model = null, resetsAtMs = null) {
  const result = await mutate((data) => {
    const account = data.accounts.find((a) => a.id === id);
    if (!account) return { shouldFallback: false, cooldownMs: 0 };

    const backoffLevel = account.backoffLevel || 0;

    let shouldFallback, cooldownMs, newBackoffLevel;
    if (resetsAtMs && resetsAtMs > Date.now()) {
      shouldFallback = true;
      cooldownMs = Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
      newBackoffLevel = 0;
    } else {
      ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errText, backoffLevel));
    }

    if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

    const lockUpdate = buildModelLockUpdate(model, cooldownMs);
    Object.assign(account, lockUpdate);
    account.errorCode = status;
    account.lastError = typeof errText === "string" ? errText.slice(0, 200) : "Provider error";
    account.lastErrorAt = new Date().toISOString();
    account.backoffLevel = newBackoffLevel ?? backoffLevel;
    account.updatedAt = account.lastErrorAt;
    return { shouldFallback: true, cooldownMs };
  });
  return result;
}

/**
 * Clear error state on an account after a successful request for `model`.
 *
 * - Always clears `modelLock_<model>` and the all-models lock
 * - Lazy-cleans any other expired modelLock_* keys
 * - Only resets errorCode/lastError/backoffLevel if no active locks remain
 */
export async function clearAccountError(id, model = null) {
  await mutate((data) => {
    const account = data.accounts.find((a) => a.id === id);
    if (!account) return;

    const now = Date.now();
    const lockKeys = Object.keys(account).filter((k) => k.startsWith(MODEL_LOCK_PREFIX));
    const succeeded = model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;

    let mutated = false;
    for (const k of lockKeys) {
      const expiry = account[k];
      const isSucceeded = k === succeeded || k === MODEL_LOCK_ALL;
      const isExpired = expiry && new Date(expiry).getTime() <= now;
      if (isSucceeded || isExpired) {
        account[k] = null;
        mutated = true;
      }
    }

    const stillActive = Object.keys(account).some((k) => {
      if (!k.startsWith(MODEL_LOCK_PREFIX)) return false;
      const expiry = account[k];
      return expiry && new Date(expiry).getTime() > now;
    });

    if (!stillActive) {
      if (account.errorCode != null || account.lastError != null || account.backoffLevel) {
        account.errorCode = null;
        account.lastError = null;
        account.lastErrorAt = null;
        account.backoffLevel = 0;
        mutated = true;
      }
    }

    if (mutated) account.updatedAt = new Date().toISOString();
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/accountsStore.test.js`
Expected: All accountsStore tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/accountsStore.js lib/accountsStore.test.js
git commit -m "feat(accounts): markAccountUnavailable + clearAccountError"
```

---

### Task 11: Create `lib/requestInspector.js` (one-shot logger)

**Files:**
- Create: `lib/requestInspector.js`

- [ ] **Step 1: Implement the inspector**

```js
/**
 * One-shot request inspector: when INSPECT_REQUESTS=N is set, the next N
 * /v1/messages requests are logged to ~/.claude-server/request-inspect.log
 * with headers + metadata + message shape (NO content). Used to discover
 * what stable identifiers Claude Code CLI emits.
 *
 * Disable by removing the env var. Counter persists in memory only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function resolveDataDir() {
  if (process.env.CLAUDE_SERVER_DATA_DIR) return process.env.CLAUDE_SERVER_DATA_DIR;
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "claude-server"
    );
  }
  return path.join(os.homedir(), ".claude-server");
}

const LOG_FILE = path.join(resolveDataDir(), "request-inspect.log");
let remaining = parseInt(process.env.INSPECT_REQUESTS || "0", 10);
if (!Number.isFinite(remaining) || remaining < 0) remaining = 0;

function safeBodyShape(body) {
  if (!body || typeof body !== "object") return null;
  const messages = Array.isArray(body.messages)
    ? body.messages.map((m) => ({
        role: m.role,
        content_type: typeof m.content,
        content_length: typeof m.content === "string" ? m.content.length : Array.isArray(m.content) ? m.content.length : 0,
      }))
    : [];
  return {
    model: body.model,
    has_system: !!body.system,
    system_type: typeof body.system,
    system_length: typeof body.system === "string"
      ? body.system.length
      : Array.isArray(body.system) ? body.system.length : 0,
    metadata: body.metadata || null,
    messages_count: messages.length,
    messages_shape: messages,
    first_message_preview: typeof body.messages?.[0]?.content === "string"
      ? body.messages[0].content.slice(0, 200)
      : null,
  };
}

export function inspectRequest(headers, body) {
  if (remaining <= 0) return;
  try {
    const lowerHeaders = {};
    for (const [k, v] of Object.entries(headers || {})) lowerHeaders[k.toLowerCase()] = v;
    const entry = {
      ts: new Date().toISOString(),
      headers: lowerHeaders,
      body_shape: safeBodyShape(body),
    };
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
    remaining--;
    if (remaining === 0) {
      fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), note: "inspector complete, stopping" }) + "\n");
      console.log(`[inspector] captured all configured requests; logged to ${LOG_FILE}`);
    }
  } catch (e) {
    console.warn("[inspector] failed:", e.message);
  }
}

export function isInspecting() {
  return remaining > 0;
}
```

- [ ] **Step 2: Quick functional check**

Run a one-liner to verify the module loads:
```bash
INSPECT_REQUESTS=2 node -e "import('./lib/requestInspector.js').then(m => { m.inspectRequest({ 'x-test': '1' }, { messages: [{ role:'user', content:'hi' }] }); console.log('isInspecting:', m.isInspecting()); })"
```
Expected: prints `isInspecting: true`. Check that `~/.claude-server/request-inspect.log` (or `%APPDATA%\claude-server\request-inspect.log` on Windows) contains one JSON line with the test header and body shape.

- [ ] **Step 3: Commit**

```bash
git add lib/requestInspector.js
git commit -m "feat(inspector): one-shot request logger gated by INSPECT_REQUESTS"
```

---

### Task 12: Refactor `proxy.js` — sticky routing + new fallback loop

**Files:**
- Modify: `lib/proxy.js`

This is the largest single change. The new flow replaces `acquireAccount` and rewrites `runWithFailover` to use `preferredAccountId`, `excludeIds`, model-aware lock filtering, and `markAccountUnavailable`/`clearAccountError`. Both `handleMessages` and `handleChatCompletions` already use `runWithFailover`, so they're updated transparently — but each must compute `sessionKey` and feed it via `ctx`.

- [ ] **Step 1: Add new imports at the top of `lib/proxy.js`**

After the existing imports (around line 12):
```js
import {
  pickActiveAccount,
  countAccounts,
  listAccounts,
  markAccountUnavailable,
  clearAccountError,
} from "./accountsStore.js";
import { computeSessionKey } from "./sessionKey.js";
import { getRoute, setRoute } from "./sessionRoutes.js";
import { inspectRequest } from "./requestInspector.js";
```

Remove the now-redundant imports at lines 4-10 (the consolidated import above replaces them — `pickActiveAccount`, `markAccountUsed`, `markAccountError`, `countAccounts`, `listAccounts`). Note: `markAccountUsed` and `markAccountError` are no longer used in the new flow. Keep the `ensureFreshAccount` import from `./claudeOAuth.js` and `insertRequestLog` from `./db.js`.

The final import block at the top of `proxy.js` should be:
```js
import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import { openaiToClaude, claudeToOpenai, claudeStreamChunkToOpenai, createStreamState } from "./translate.js";
import {
  pickActiveAccount,
  countAccounts,
  listAccounts,
  markAccountUnavailable,
  clearAccountError,
} from "./accountsStore.js";
import { ensureFreshAccount } from "./claudeOAuth.js";
import { insertRequestLog } from "./db.js";
import { computeSessionKey } from "./sessionKey.js";
import { getRoute, setRoute } from "./sessionRoutes.js";
import { inspectRequest } from "./requestInspector.js";
```

- [ ] **Step 2: Add `parseRetryAfter` helper**

After `applyCloaking` (around line 50), add:
```js
function parseRetryAfter(err) {
  // Anthropic SDK surfaces upstream headers via err.headers; check common shapes.
  const h = err?.headers || err?.response?.headers || null;
  const raw = h
    ? (typeof h.get === "function" ? h.get("retry-after") : h["retry-after"])
    : null;
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) return Date.now() + seconds * 1000;
    // RFC 7231 also permits HTTP-date — try parsing
    const ts = Date.parse(raw);
    if (!Number.isNaN(ts) && ts > Date.now()) return ts;
  }
  // Some Anthropic errors include retry_after in the body
  const bodyRetry = err?.error?.error?.retry_after || err?.error?.retry_after;
  if (bodyRetry && Number.isFinite(Number(bodyRetry))) {
    return Date.now() + Number(bodyRetry) * 1000;
  }
  return null;
}
```

- [ ] **Step 3: Replace `acquireAccount` and `runWithFailover`**

Delete the existing `acquireAccount` function (lines 92-100 of the current file).

Replace `runWithFailover` (currently at lines 126-162) with the new implementation:
```js
/**
 * Run an attempt against a Claude account, with sticky routing + fallback.
 *
 * @param {object} config
 * @param {http.ServerResponse} clientRes
 * @param {(args: { client: Anthropic, account: object | null }) => Promise<any>} attempt
 * @param {object} ctx — populated by caller (sessionKey, model). model may
 *   be set inside attempt — see prepareBody flow.
 */
async function runWithFailover(config, clientRes, attempt, ctx) {
  if (config.apiKey) {
    return attempt({ client: createApiKeyClient(config), account: null });
  }

  if ((await countAccounts()) === 0) {
    throw new Error("No Claude accounts configured. Add one from /dashboard/accounts.");
  }

  let preferredAccountId = ctx.sessionKey ? getRoute(ctx.sessionKey) : null;
  const excludeIds = new Set();
  let lastError = null;

  while (true) {
    const picked = await pickActiveAccount({
      excludeIds,
      model: ctx.model,
      preferredAccountId,
    });

    if (!picked) {
      throw lastError || new Error("No active Claude accounts available");
    }
    if (picked.allLocked) {
      const err = new Error(picked.lastError || "All Claude accounts are rate-limited");
      err.status = picked.lastErrorCode || 503;
      err.retryAfterIso = picked.retryAfter;
      err.retryAfterHuman = picked.retryAfterHuman;
      throw err;
    }

    const account = await ensureFreshAccount(picked);
    ctx.accountId = account.id;
    console.log(`[proxy] -> using account ${account.name || account.id} (preferred=${preferredAccountId === account.id})`);

    try {
      const result = await attempt({ account, client: createClient(config, account.accessToken) });
      if (ctx.sessionKey) setRoute(ctx.sessionKey, account.id);
      await clearAccountError(account.id, ctx.model);
      return result;
    } catch (err) {
      const status = err?.status || err?.response?.status || 500;
      const message = err?.message || "Unknown error";
      const resetsAtMs = parseRetryAfter(err);

      const { shouldFallback } = await markAccountUnavailable(
        account.id, status, message, ctx.model, resetsAtMs
      );

      if (!shouldFallback || clientRes.headersSent) throw err;

      excludeIds.add(account.id);
      preferredAccountId = null; // session pin failed; let strategy pick next
      lastError = err;
      console.warn(`[proxy] account ${account.id.slice(0,8)} failed (${status}); falling back`);
    }
  }
}
```

- [ ] **Step 4: Wire `sessionKey` into `handleMessages`**

Find `handleMessages` (around line 164). Update its signature and body to accept request headers and compute session key. Replace the function with:
```js
export async function handleMessages(reqBody, clientRes, config, options = {}) {
  const startTime = Date.now();
  const ctx = {
    accountId: null,
    model: null,
    stream: false,
    inputTokens: null,
    outputTokens: null,
    sessionKey: null,
  };
  const userToken = options.userToken && !options.userToken.bypass ? options.userToken : null;
  const reqHeaders = options.reqHeaders || {};
  inspectRequest(reqHeaders, reqBody);
  ctx.sessionKey = computeSessionKey(reqHeaders, reqBody, userToken?.id);

  let status = 0;
  let errMsg = null;

  try {
    await runWithFailover(config, clientRes, async ({ client, account }) => {
      const token = account?.accessToken || config.apiKey;
      const prepared = prepareBody({ ...reqBody }, token);
      ctx.model = prepared.model || null;
      ctx.stream = !!prepared.stream;

      console.log(`[proxy] -> /v1/messages (account: ${account?.id || "api-key"}, stream: ${ctx.stream}, model: ${ctx.model}, sessionKey: ${ctx.sessionKey ? ctx.sessionKey.slice(0,16)+"…" : "none"})`);

      if (prepared.stream) {
        const stream = await client.messages.create({ ...prepared, stream: true });
        clientRes.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        for await (const event of stream) {
          if (event.type === "message_start" && event.message?.usage) {
            ctx.inputTokens = event.message.usage.input_tokens ?? ctx.inputTokens;
          }
          if (event.type === "message_delta" && event.usage) {
            ctx.outputTokens = event.usage.output_tokens ?? ctx.outputTokens;
          }
          clientRes.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        clientRes.end();
        status = 200;
      } else {
        const response = await client.messages.create(prepared);
        ctx.inputTokens = response.usage?.input_tokens ?? null;
        ctx.outputTokens = response.usage?.output_tokens ?? null;
        clientRes.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        clientRes.end(JSON.stringify(response));
        status = 200;
      }
    }, ctx);
  } catch (err) {
    console.error(`[proxy] error ${err.status || ""}:`, err.message);
    status = err.status || 502;
    errMsg = err.message;
    if (!clientRes.headersSent) {
      const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
      if (err.retryAfterIso) {
        const secs = Math.max(1, Math.ceil((new Date(err.retryAfterIso).getTime() - Date.now()) / 1000));
        headers["Retry-After"] = String(secs);
      }
      clientRes.writeHead(status, headers);
    }
    clientRes.end(JSON.stringify(err.error || { type: "error", error: { type: "proxy_error", message: err.message } }));
  } finally {
    try {
      const tokens_used = (ctx.inputTokens || 0) + (ctx.outputTokens || 0) || null;
      insertRequestLog({
        timestamp: new Date(startTime).toISOString(),
        method: "POST",
        path: "/v1/messages",
        status,
        latency_ms: Date.now() - startTime,
        model: ctx.model,
        account_id: ctx.accountId,
        input_tokens: ctx.inputTokens,
        output_tokens: ctx.outputTokens,
        tokens_used,
        stream: ctx.stream ? 1 : 0,
        error: errMsg,
        user_token_id: userToken?.id || null,
        user_email: userToken?.userEmail || null,
      });
    } catch (e) {
      console.error("[logging] failed:", e.message);
    }
  }
}
```

- [ ] **Step 5: Wire `sessionKey` into `handleChatCompletions`**

Apply the same pattern to `handleChatCompletions` (currently around line 243). Replace with:
```js
export async function handleChatCompletions(reqBody, clientRes, config, options = {}) {
  const startTime = Date.now();
  const ctx = {
    accountId: null,
    model: null,
    stream: false,
    inputTokens: null,
    outputTokens: null,
    sessionKey: null,
  };
  const userToken = options.userToken && !options.userToken.bypass ? options.userToken : null;
  const reqHeaders = options.reqHeaders || {};
  // Translate up front so sessionKey hashes the Claude-native shape
  const claudeBodyForKey = openaiToClaude(reqBody);
  inspectRequest(reqHeaders, claudeBodyForKey);
  ctx.sessionKey = computeSessionKey(reqHeaders, claudeBodyForKey, userToken?.id);

  let status = 0;
  let errMsg = null;

  try {
    await runWithFailover(config, clientRes, async ({ client, account }) => {
      const token = account?.accessToken || config.apiKey;
      const claudeBody = openaiToClaude(reqBody);
      const prepared = prepareBody({ ...claudeBody }, token);
      ctx.model = prepared.model || null;
      ctx.stream = !!prepared.stream;

      console.log(`[proxy] -> /v1/chat/completions (account: ${account?.id || "api-key"}, stream: ${ctx.stream}, model: ${ctx.model})`);

      if (prepared.stream) {
        const state = createStreamState();
        const stream = await client.messages.create({ ...prepared, stream: true });
        clientRes.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        for await (const event of stream) {
          if (event.type === "message_start" && event.message?.usage) {
            ctx.inputTokens = event.message.usage.input_tokens ?? ctx.inputTokens;
          }
          if (event.type === "message_delta" && event.usage) {
            ctx.outputTokens = event.usage.output_tokens ?? ctx.outputTokens;
          }
          const openaiChunks = claudeStreamChunkToOpenai(event, state);
          if (openaiChunks) {
            for (const chunk of openaiChunks) {
              clientRes.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
          }
        }
        clientRes.end();
        status = 200;
      } else {
        const response = await client.messages.create(prepared);
        ctx.inputTokens = response.usage?.input_tokens ?? null;
        ctx.outputTokens = response.usage?.output_tokens ?? null;
        const openaiResponse = claudeToOpenai(response);
        clientRes.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        clientRes.end(JSON.stringify(openaiResponse));
        status = 200;
      }
    }, ctx);
  } catch (err) {
    console.error(`[proxy] error ${err.status || ""}:`, err.message);
    status = err.status || 502;
    errMsg = err.message;
    if (!clientRes.headersSent) {
      const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
      if (err.retryAfterIso) {
        const secs = Math.max(1, Math.ceil((new Date(err.retryAfterIso).getTime() - Date.now()) / 1000));
        headers["Retry-After"] = String(secs);
      }
      clientRes.writeHead(status, headers);
    }
    clientRes.end(JSON.stringify({ error: { message: err.message, type: "api_error", code: status } }));
  } finally {
    try {
      const tokens_used = (ctx.inputTokens || 0) + (ctx.outputTokens || 0) || null;
      insertRequestLog({
        timestamp: new Date(startTime).toISOString(),
        method: "POST",
        path: "/v1/chat/completions",
        status,
        latency_ms: Date.now() - startTime,
        model: ctx.model,
        account_id: ctx.accountId,
        input_tokens: ctx.inputTokens,
        output_tokens: ctx.outputTokens,
        tokens_used,
        stream: ctx.stream ? 1 : 0,
        error: errMsg,
        user_token_id: userToken?.id || null,
        user_email: userToken?.userEmail || null,
      });
    } catch (e) {
      console.error("[logging] failed:", e.message);
    }
  }
}
```

- [ ] **Step 6: Pass headers from `index.js`**

In `index.js` lines 187-189 and 196-197 (the `/v1/messages` and `/v1/chat/completions` handlers), update the call to include headers:

Replace:
```js
await handleMessages(body, res, config, { userToken });
```
with:
```js
await handleMessages(body, res, config, { userToken, reqHeaders: req.headers });
```

Same change for `handleChatCompletions`.

- [ ] **Step 7: Run all unit tests to confirm no regressions**

Run: `npm test`
Expected: All previous tests still PASS (we didn't change tested module surfaces incompatibly).

- [ ] **Step 8: Smoke test**

Run: `npm run dev`
With at least one valid Claude account configured, send a real request:
```bash
curl -X POST http://localhost:8080/v1/messages \
  -H 'Authorization: Bearer cs_<your-token>' \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":50,"messages":[{"role":"user","content":"Say hi"}]}'
```
Expected: 200 response. Console logs show `account: ...`, `sessionKey: ...`. `request_logs` row recorded with `user_email`.

Send a second identical request — console should show `preferred=true`.

- [ ] **Step 9: Commit**

```bash
git add lib/proxy.js index.js
git commit -m "feat(proxy): sticky routing + 9router-style fallback

- computeSessionKey from headers/body before each request
- preferredAccountId from sessionRoutes; LRU when no pin
- per-(account, model) lock filter on pick
- exponential backoff via accountFallback + retry-after parsing
- excludeIds set prevents retrying same account in one request
- writes session route on success, clears model lock
- emits Retry-After header when all accounts are rate-limited
"
```

---

### Task 13: Surface model-lock state in dashboard accounts UI

**Files:**
- Modify: `next-app/app/api/claude/accounts/route.ts`
- Modify: `next-app/app/dashboard/accounts/page.tsx`

- [ ] **Step 1: Extend the API redact function to include lock state**

In `next-app/app/api/claude/accounts/route.ts`, replace `redact`:
```ts
function redact(account: ClaudeAccount & Record<string, unknown>) {
  const modelLocks: Array<{ model: string; until: string }> = [];
  let earliestLockUntil: string | null = null;
  for (const [k, v] of Object.entries(account)) {
    if (!k.startsWith("modelLock_") || !v || typeof v !== "string") continue;
    const t = new Date(v).getTime();
    if (!Number.isFinite(t) || t <= Date.now()) continue;
    const model = k === "modelLock___all" ? "*" : k.slice("modelLock_".length);
    modelLocks.push({ model, until: v });
    if (!earliestLockUntil || t < new Date(earliestLockUntil).getTime()) {
      earliestLockUntil = v;
    }
  }
  modelLocks.sort((a, b) => new Date(a.until).getTime() - new Date(b.until).getTime());

  return {
    id: account.id,
    name: account.name,
    email: account.email,
    expiresAt: account.expiresAt,
    isActive: account.isActive,
    lastUsedAt: account.lastUsedAt,
    lastError: account.lastError,
    lastErrorAt: account.lastErrorAt,
    errorCode: (account as { errorCode?: number | null }).errorCode ?? null,
    backoffLevel: (account as { backoffLevel?: number }).backoffLevel ?? 0,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    accessTokenPreview: account.accessToken
      ? `${account.accessToken.slice(0, 12)}…${account.accessToken.slice(-4)}`
      : null,
    hasRefreshToken: !!account.refreshToken,
    modelLocks,
    earliestLockUntil,
  };
}
```

- [ ] **Step 2: Render lock state in the page**

In `next-app/app/dashboard/accounts/page.tsx`:

Extend the `AccountRow` interface (lines 20-33):
```ts
interface AccountRow {
  id: string;
  name: string;
  email: string | null;
  expiresAt: string | null;
  isActive: boolean;
  lastUsedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  errorCode: number | null;
  backoffLevel: number;
  createdAt: string;
  updatedAt: string;
  accessTokenPreview: string | null;
  hasRefreshToken: boolean;
  modelLocks: Array<{ model: string; until: string }>;
  earliestLockUntil: string | null;
}
```

Add a helper above `statusOf`:
```tsx
function formatLockCountdown(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return "0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
```

Update `statusOf` to mark locked accounts:
```tsx
function statusOf(account: AccountRow): { label: string; tone: StatusTone } {
  if (!account.isActive) return { label: "disabled", tone: "secondary" };
  if (account.modelLocks.length > 0) return { label: "locked", tone: "destructive" };
  if (account.lastError) return { label: "error", tone: "destructive" };
  return { label: "active", tone: "default" };
}
```

Add a poll interval so the countdown ticks. Inside `AccountsPage`, after the existing `useEffect`, add:
```tsx
useEffect(() => {
  const id = setInterval(() => {
    // Re-render to refresh countdowns; data poll happens via load() if needed
    setAccounts((cur) => (cur ? [...cur] : cur));
  }, 1000);
  return () => clearInterval(id);
}, []);

useEffect(() => {
  const id = setInterval(load, 30_000);
  return () => clearInterval(id);
}, [load]);
```

Insert a new column in the Table, between Status and Token. In `<TableHeader>`:
```tsx
<TableHead>Locks</TableHead>
```

In each `<TableRow>`, after the Status `<TableCell>`:
```tsx
<TableCell>
  {account.modelLocks.length === 0 ? (
    <span className="text-xs text-muted-foreground">clear</span>
  ) : (
    <div className="space-y-0.5">
      {account.modelLocks.slice(0, 3).map((lk) => (
        <div key={lk.model} className="text-xs">
          <code className="text-muted-foreground">{lk.model}</code>
          <span className="ml-1 text-destructive">{formatLockCountdown(lk.until)}</span>
        </div>
      ))}
      {account.modelLocks.length > 3 && (
        <div className="text-xs text-muted-foreground">+{account.modelLocks.length - 3} more</div>
      )}
    </div>
  )}
</TableCell>
```

- [ ] **Step 3: Visual verification**

With the dev server running and a test account:
1. Run a request that fails (e.g., temporarily set the access token to garbage in the dashboard, or use `curl` with an obviously wrong API key configured upstream)
2. Open `/dashboard/accounts`
3. Confirm Locks column shows `sonnet 1m 59s` (or similar) and counts down each second
4. Status badge shows "locked" / "destructive"
5. After cooldown elapses, lock disappears on next 30s poll

- [ ] **Step 4: Commit**

```bash
git add next-app/app/api/claude/accounts/route.ts next-app/app/dashboard/accounts/page.tsx
git commit -m "feat(dashboard): show per-(account,model) lock countdown"
```

---

### Task 14: Integration smoke + regression checklist

**Files:** none (verification only)

- [ ] **Step 1: Confirm all unit tests still pass**

Run: `npm test`
Expected: All tests across `lib/*.test.js` PASS.

- [ ] **Step 2: Verify Phase 1 — Leaderboard**

With dev server running:
- Navigate to `/dashboard/leaderboard`
- Verify period selector + sort toggle work
- Verify ranks/medals render correctly
- If `request_logs` is empty, see "No usage data" empty state
- Make a real request, refresh, see your email appear

- [ ] **Step 3: Verify sticky routing across turns**

With at least 2 active Claude accounts:
1. Reset accounts (delete `accounts.json` `lastUsedAt`, or just observe a fresh state)
2. Send 3 sequential `/v1/messages` requests with the same `messages[0].content`
3. Check console output — all three should log the same account name/id
4. Check `request_logs` — all three rows should have the same `account_id`

Expected: same `account_id` across the 3 rows.

- [ ] **Step 4: Verify fallback on hard error**

1. In the dashboard, edit one Claude account's access token to be invalid (or use the "force pin" path: import `setRoute` in a one-shot REPL and call it for the bad account)
2. Send a request whose session_key would route there
3. Observe console: error → fallback → success on a different account
4. Open `/dashboard/accounts` — bad account shows lock countdown
5. Send a follow-up request with same `messages[0]` — should now go to the new (good) account directly (route was rewritten on success)

- [ ] **Step 5: Verify all-locked path**

1. Disable all but one account in the dashboard
2. Force lock the remaining account: trigger 3-4 deliberate 429s (or directly call `markAccountUnavailable` via REPL with a model name)
3. Send a request — expect 503 with `Retry-After` header

- [ ] **Step 6: Run inspector against a real Claude Code CLI**

This step gathers evidence to simplify `computeSessionKey`. Run on the deployment machine:
```bash
INSPECT_REQUESTS=10 npm run dev:proxy
```
Then run actual `claude` CLI sessions configured to point at this proxy. Make ~10 requests, then read `~/.claude-server/request-inspect.log` (or `%APPDATA%\claude-server\request-inspect.log`).

Look for:
- A header that's stable across multiple requests of the same conversation but changes between conversations
- A field in `metadata` beyond `user_id`
- Anything that contains `conversation`, `session`, `trace`

Document findings in a new file: `docs/superpowers/notes/claude-code-request-shape.md` with one observation per line.

- [ ] **Step 7: Regression checks**

- API-key bypass mode: set `ANTHROPIC_API_KEY=sk-ant-...` env, restart, send request without `Authorization: Bearer cs_*` — should still work (no sticky routing applies).
- `/dashboard/usage` aggregates unchanged.
- `/dashboard/logs` page loads and shows recent rows.
- `/dashboard/health` page loads, shows token status.
- `/dashboard/tokens` create/revoke flow still works.
- Token refresh cron logs every 30 min on long runs (or trigger via `npm run test:refresh`).

- [ ] **Step 8: Commit any minor doc updates**

If the inspector findings warrant a follow-up to simplify `computeSessionKey`, that's a separate PR — not part of this plan. Just commit the notes:
```bash
git add docs/superpowers/notes/
git commit -m "docs: notes on Claude Code request shape (inspector capture)"
```

---

## Self-review

**Spec coverage check:**

| Spec section | Implementing tasks |
|---|---|
| Phase 1: API endpoint | T3 |
| Phase 1: Page UI | T4 |
| Phase 1: Sidebar | T5 |
| Phase 1: SQL aggregate | T1 |
| Phase 2: Session key | T8, T12 step 4 |
| Phase 2: Inspector | T11, T12 step 4-5, T14 step 6 |
| Phase 2: Session route store | T7 |
| Phase 2: accountFallback module | T6 |
| Phase 2: accountsStore additions | T9 (pick + flags), T10 (markUnavailable + clearError) |
| Phase 2: proxy refactor | T12 |
| Phase 2: Lock UI | T13 |
| Edge case: streaming | T12 step 3 (`clientRes.headersSent` check preserved) |
| Edge case: API-key bypass | T12 step 3 (`config.apiKey` short-circuit) + T14 step 7 |
| Edge case: pinned account deleted | Falls out of T9 logic (eligible.find returns null → strategy) |
| Edge case: pinned account locked | T9 — lock filter runs before preferredAccountId check |
| Edge case: concurrent same-key | T9 mutex (single mutate call) |
| Edge case: all-locked | T9 returns `{allLocked:true}` + T12 step 3 throws with Retry-After |
| Edge case: schema migration | Additive fields, T9-10 use `??` defaults |
| Edge case: inspector log size | T11 counter-based |
| Testing strategy | T6, T7, T8, T9, T10 (unit) + T14 (manual) |
| Rollout — backward compat | T9 step 6 updates the only caller |

All spec sections covered.

**Placeholder scan:** No "TBD"/"TODO"/"implement later"/"add appropriate"/"similar to" left in the plan.

**Type/name consistency:**
- `pickActiveAccount({ excludeIds, model, preferredAccountId })` — same signature in T9 and used in T12.
- `markAccountUnavailable(id, status, errText, model, resetsAtMs)` — same in T10 and T12.
- `clearAccountError(id, model)` — same in T10 and T12.
- `computeSessionKey(headers, body, userTokenId)` — same in T8 and T12.
- `getRoute` / `setRoute` — same in T7 and T12.
- `inspectRequest(headers, body)` — same in T11 and T12.
- `parseRetryAfter(err)` returns epoch-ms or `null` — used in T12 step 2 and step 3.

All consistent.
