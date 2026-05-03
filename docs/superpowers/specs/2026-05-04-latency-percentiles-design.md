# Latency Percentile Trend Chart — Design

**Date:** 2026-05-04
**Status:** Draft (awaiting user review)
**Surface:** `/dashboard` (overview page)

## Goal

Add a time-series chart of request latency percentiles (p50, p95, p99) to the
overview page. The existing dashboard reports a single `avgLatencyMs` KPI which
hides tail behavior — a slow p99 with a fast average is invisible today. The
chart turns "how is the proxy actually performing right now?" into a glance.

This feature does not duplicate any existing page:
- `/dashboard/usage` charts token *volume*, not latency.
- `/dashboard/logs` shows per-row latency but no aggregate or trend.
- `/dashboard/health` shows upstream Anthropic quotas, unrelated to proxy
  latency.

## Out of scope (explicitly)

- Per-model latency breakdown.
- A 30d period selector. The overview is for "right now"; deeper drill-down
  is future work.
- Alerting / threshold notifications on percentile spikes.
- Replacing or removing the existing `Avg Latency` KPI card. Chart and card
  serve different jobs (trend vs current snapshot); both stay.

## Data source

`request_logs` table (SQLite, `lib/db.js`). Columns used:
- `timestamp` — request start, ISO 8601.
- `latency_ms` — end-to-end proxy latency, integer ms.
- `status` — HTTP status returned to the client.

The table already has `idx_timestamp`. No schema change required.

**Sample filter:** include only rows where `status = 200`. Errors short-circuit
fast (auth failures, validation) or hang to a timeout, and both poison the
percentile distribution. Excluding errors keeps the chart a faithful view of
serving latency. Streaming and non-streaming requests are both included; the
end-to-end `latency_ms` is meaningful for both.

## API

New endpoint: `GET /api/stats/latency?period=24h|7d`

**Auth:** session-cookie auth like the existing `/api/stats`. Same access
rules — anyone logged into the dashboard can view.

**Default:** `period=24h` if the query param is missing or invalid.

**Response shape:**
```json
{
  "period": "24h",
  "bucketSeconds": 900,
  "points": [
    { "bucket": "2026-05-03T18:45:00Z", "p50": 312, "p95": 1840, "p99": 4210, "n": 27 },
    { "bucket": "2026-05-03T19:00:00Z", "p50": null, "p95": null, "p99": null, "n": 0 }
  ]
}
```

- `bucket` is the ISO timestamp at the start of the bucket.
- `p50` / `p95` / `p99` are integer ms. `null` when the bucket has zero
  successful requests.
- `n` is the number of successful samples in the bucket. Useful for the
  tooltip and for users to spot low-confidence buckets.

**Bucket sizes:**
- `period=24h` → 96 buckets of 15 minutes (`bucketSeconds: 900`).
- `period=7d` → 168 buckets of 1 hour (`bucketSeconds: 3600`).

Buckets are aligned to UTC clock boundaries — every 15 minutes on the dot for
24h, every hour on the dot for 7d. The window is `[now - period, now]`,
truncated at the start to the nearest bucket boundary so the leftmost bucket
is complete.

## Computation

SQLite's bundled build in `better-sqlite3` does not ship `PERCENTILE_CONT`.
Computing in JavaScript is simple and fast at expected volumes.

Algorithm (one helper in `lib/db.js`):

1. Single `SELECT timestamp, latency_ms FROM request_logs WHERE status = 200
   AND timestamp >= ?` for the window.
2. Group rows into buckets by flooring `timestamp` to `bucketSeconds`.
3. For each bucket: sort `latency_ms` ascending, then pick percentiles by
   index with linear interpolation between adjacent points. Standard
   percentile-of-sorted-array implementation.
4. Emit a point for every bucket in the window — empty buckets produce
   `{ p50: null, p95: null, p99: null, n: 0 }` so the chart renders a gap
   instead of inventing a connecting line.

**Scale check:** at the current ~360 successful requests per 24h, the 24h
query returns ~360 rows; the 7d query returns ~2.5k rows. Sorting and
bucketing in JS is microseconds. Even at 100× the current volume (~36k rows
for 7d) this stays trivial.

## Frontend

File: `next-app/app/dashboard/page.tsx`. The existing 3-card KPI row stays
untouched. Below it, add a single full-width card containing the chart.

**Card layout:**
- Header: title `Latency`, subtitle `p50 / p95 / p99 over time`. Inline
  toggle on the right with two buttons: `24h` (default) and `7d`. Pattern
  follows the period toggle on `/dashboard/usage`.
- Body: a `recharts` line chart inside the existing `ChartContainer` from
  `components/ui/chart.tsx`, so it inherits the dashboard's theme tokens.
- Three lines, not stacked area: stacked area would imply additivity which
  is meaningless for percentiles.
- Suggested colors (from the existing chart palette): p50 green/teal, p95
  amber, p99 red. The theme already exposes chart color slots; pick whatever
  matches the tone.
- Y axis: milliseconds, auto-scaled, no fixed maximum.
- X axis: time, formatted `HH:mm` for 24h and `MMM d HH:00` for 7d.
- Tooltip on hover: shows all three percentiles plus `n` for the bucket
  ("27 samples").

**Empty state:** if every bucket in the window has `n = 0`, render the card
header normally and the chart area shows a centered "No successful requests
in this period" message. No fake zero line.

**Loading state:** matches the existing dashboard pattern — render the card
shell with `—` until the fetch resolves.

**Refresh:** fetch on mount and on period change. No polling for v1; the
overview's other tiles also fetch once on mount. A refresh button could be
added later if anyone asks.

## Relationship to existing KPIs

The existing `Avg Latency` card on the overview is computed by
`getStats()` in `lib/db.js` as `AVG(latency_ms)` filtered only by today's
calendar date — it includes error rows and uses a calendar-day window
(UTC). The new percentile chart deliberately differs on both axes:

- **Successful only** (`status = 200`) — for the reasons in the Sample
  Filter section above.
- **Rolling window** (last 24h, not "today") — better answers "is the
  proxy slow right now?" near the start of a UTC day.

These are not inconsistencies to fix; they reflect that the two surfaces
answer different questions. The spec calls them out so future changes do
not silently align them.

## Edge cases

- **Time zones:** all bucketing uses UTC. The chart x-axis renders in the
  user's local time using the browser's `Intl.DateTimeFormat` to match how
  `/dashboard/logs` already formats `timestamp`.
- **Clock skew between proxy host and dashboard host:** all timestamps come
  from the proxy host's clock, so internal consistency is fine. The "last
  24h" cutoff uses the proxy host's `datetime('now','-1 day')` equivalent.
- **Data older than a few days:** existing `request_logs` has no retention
  policy. The 7d query reads everything in the window even if older data is
  present — the index on `timestamp` keeps this cheap.

## Files to touch

- `lib/db.js` — new helper (e.g., `getLatencyPercentiles({ period })`)
  alongside the existing `getStats`.
- `next-app/app/api/stats/latency/route.ts` — new route that calls the
  helper and returns the JSON shape above.
- `next-app/app/dashboard/page.tsx` — extend `Stats` interface
  considerations (no change to `/api/stats`), add the new card.

No changes to `lib/proxy.js`, `accountsStore.js`, or any other route. No
schema migration.

## Future work (post-v1, not for this spec)

- Per-model breakdown (filter or split-line view).
- 30d period and per-day buckets.
- Threshold alerts (e.g., raise an issue when p99 stays above X ms for Y
  buckets in a row) — pairs with a future Issues Feed.
