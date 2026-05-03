# Per-user usage leaderboard + sticky account routing

**Date:** 2026-05-04
**Status:** Design

## Problem

The proxy serves multiple users (Google-OAuth registered, each with their own `cs_*` API tokens) backed by multiple Claude OAuth accounts. Two gaps today:

1. **No visibility into who consumes what.** `request_logs` records `user_email` per request, but no UI surfaces it. Operators can't see who the heavy users are.
2. **Account selection is content-blind.** `pickActiveAccount` returns the least-recently-used active account (round-robin LRU). Successive turns of the same Claude Code conversation hit different Claude accounts, so Anthropic's prompt cache (keyed per account) misses on every turn after the first. Users pay full input tokens repeatedly.

## Goals

- A leaderboard visible to all signed-in users showing top token consumers, sortable by total tokens / requests, with period filters (24h / 7d / 30d / all).
- Sticky routing: the first turn of a conversation pins to a Claude account; all subsequent turns of that conversation hit the same account, preserving prompt-cache benefits.
- A precise fallback mechanism (modeled on `9router`) that switches accounts only when the pinned one is genuinely unable to serve the request, with per-(account, model) locks and exponential backoff.
- The sticky-routing logic must be evidence-based: we don't yet know exactly what stable identifiers Claude Code CLI emits, so the system ships with a layered identifier strategy and a one-shot request inspector to discover the best identifier in production.

## Non-goals

- Per-user quotas / rate limits. The intent is to **fully utilize** every Claude account's quota.
- Admin-only views. The leaderboard is public to all signed-in users.
- User management actions (disable/delete users). Out of scope for this spec.
- Replacing the existing `/dashboard/usage` page. We add a new leaderboard page; usage page stays as global aggregate.

## Architecture overview

```
Claude Code CLI (many users / many machines)
   │  Authorization: Bearer cs_*
   ▼
index.js  ──── /v1/messages, /v1/chat/completions ────▶ lib/proxy.js
                                                          │
                                                          ├─ computeSessionKey(headers, body, userTokenId)
                                                          │     └▶ lib/sessionKey.js (layered strategy)
                                                          ├─ sessionRoutes.getRoute(sessionKey) → preferredAccountId
                                                          ├─ accountsStore.pickActiveAccount({ excludeIds, model, preferredAccountId })
                                                          │     └▶ lib/accountFallback.js (model-lock helpers)
                                                          ├─ on success: sessionRoutes.setRoute, clearAccountError
                                                          └─ on error : markAccountUnavailable, retry with excluded
```

Module map:

| File | Change |
|---|---|
| `lib/proxy.js` | Compute `sessionKey`, lookup `preferredAccountId`, retry loop with `excludeIds`, parse Anthropic 429 reset header, persist route on success |
| `lib/accountsStore.js` | `pickActiveAccount` accepts `{ excludeIds, model, preferredAccountId }`, mutex-protected; new `markAccountUnavailable`, `clearAccountError`; new flat per-account fields |
| `lib/accountFallback.js` | **NEW** — adapted from `9router/open-sse/services/accountFallback.js` and `errorConfig.js` |
| `lib/sessionRoutes.js` | **NEW** — in-memory `Map<sessionKey, {accountId, lastSeen}>` with TTL prune |
| `lib/sessionKey.js` | **NEW** — `computeSessionKey` with layered candidate strategy |
| `lib/db.js` | Add `queryLeaderboard(period)` |
| `next-app/app/api/usage/leaderboard/route.ts` | **NEW** — GET handler |
| `next-app/app/dashboard/leaderboard/page.tsx` | **NEW** — page |
| `next-app/app/dashboard/components/Sidebar.tsx` | Add `Leaderboard` nav entry |
| `next-app/app/dashboard/accounts/...` | Render active model-lock state per account |

No schema migration required. `request_logs.user_email` already populated. `accounts.json` (LowDB) gains optional fields read with `?? null`; existing records work unchanged.

## Phase 1 — Leaderboard

### API: `GET /api/usage/leaderboard`

Query params:
- `period`: `24h` | `7d` | `30d` | `all` (default `7d`)
- `sort`: `total_tokens` | `requests` (default `total_tokens`)

Response:
```ts
{
  period: "24h" | "7d" | "30d" | "all",
  sort: "total_tokens" | "requests",
  rows: Array<{
    user_email: string,
    requests: number,
    input_tokens: number,
    output_tokens: number,
    total_tokens: number,
    last_active: string,  // ISO timestamp
  }>
}
```

SQL (added to `lib/db.js` as `queryLeaderboard(period, sort)`):
```sql
SELECT
  user_email,
  COUNT(*) AS requests,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS total_tokens,
  MAX(timestamp) AS last_active
FROM request_logs
WHERE user_email IS NOT NULL
  AND ($cutoff IS NULL OR timestamp >= $cutoff)
GROUP BY user_email
ORDER BY {sort} DESC
LIMIT 100
```

Period-to-cutoff mapping reuses `PERIOD_HOURS` from `getUsageStats`.

### Page: `/dashboard/leaderboard`

- Period selector (24h / 7d / 30d / all) — same component as `/dashboard/usage`
- Sort toggle (by total tokens / by requests)
- Table:
  - Rank (1, 2, 3 with medal icons; 4+ plain)
  - User (email)
  - Requests
  - Input tokens
  - Output tokens
  - Total tokens (sort key when active)
  - Last active (relative time)
- Refresh button + loading spinner
- "No data" state when `rows.length === 0`
- Visible to any signed-in user (no admin gate)

### Sidebar entry

Add between `Usage` and `Logs` in `next-app/app/dashboard/components/Sidebar.tsx`:
```ts
{ href: "/dashboard/leaderboard", label: "Leaderboard", icon: Trophy }
```

## Phase 2 — Sticky routing + fallback

### Session key

`lib/sessionKey.js`:

```js
import crypto from "node:crypto";

function firstMessageHash(body) {
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

The candidate list is intentionally over-broad. After the inspector (below) tells us what Claude Code actually emits, we trim it down to the most reliable single identifier (with content-hash kept as a safety net).

### Request inspector

Env var `INSPECT_REQUESTS=N` enables one-shot logging of the first N `/v1/messages` requests, then auto-disables.

Implementation in `lib/proxy.js`:
- On startup, read `INSPECT_REQUESTS` as integer; if > 0, initialize a counter
- On each `/v1/messages` request, if counter > 0:
  - Log to `~/.claude-server/request-inspect.log`:
    - All headers (lowercased keys)
    - `body.metadata` object
    - `body.system` keys / lengths (no content)
    - `body.messages` shape: `[{role, content_type: typeof content, length}]`
    - First 200 chars of `messages[0].content` if string (helps identify cache_control markers)
  - Decrement counter; when 0, log "Inspector complete, stopping"

After production capture, we read the log to identify the most stable identifier, simplify `computeSessionKey`, and remove `INSPECT_REQUESTS` from env.

### Session route store

`lib/sessionRoutes.js`:

```js
const routes = new Map();
const TTL_MS    = 2 * 60 * 60 * 1000;  // 2h idle
const PRUNE_MS  = 10 * 60 * 1000;      // every 10min

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

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of routes) if (v.lastSeen < cutoff) routes.delete(k);
}, PRUNE_MS).unref();
```

In-memory only. On proxy restart, all sessions re-pin on their next request — acceptable since restart is rare and the cost is one cache miss per active conversation.

### Account fallback module

`lib/accountFallback.js` adapted directly from `9router/open-sse/services/accountFallback.js` + `errorConfig.js`:

**Constants:**
- `BACKOFF_CONFIG = { base: 2000, max: 5 * 60 * 1000, maxLevel: 15 }`
- `TRANSIENT_COOLDOWN_MS = 30 * 1000`
- `MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000`
- `MODEL_LOCK_PREFIX = "modelLock_"`, `MODEL_LOCK_ALL = "modelLock___all"`

**ERROR_RULES** (text-first then status, copied from 9router):
```js
[
  { text: "no credentials",            cooldownMs: 2 * 60 * 1000 },
  { text: "request not allowed",       cooldownMs: 5 * 1000 },
  { text: "improperly formed request", cooldownMs: 2 * 60 * 1000 },
  { text: "rate limit",                backoff: true },
  { text: "too many requests",         backoff: true },
  { text: "quota exceeded",            backoff: true },
  { text: "capacity",                  backoff: true },
  { text: "overloaded",                backoff: true },
  { status: 401, cooldownMs: 2 * 60 * 1000 },
  { status: 402, cooldownMs: 2 * 60 * 1000 },
  { status: 403, cooldownMs: 2 * 60 * 1000 },
  { status: 404, cooldownMs: 2 * 60 * 1000 },
  { status: 429, backoff: true },
]
```

**Exports:**
- `getQuotaCooldown(backoffLevel)` — exponential: `min(base * 2^(level-1), max)`
- `checkFallbackError(status, errText, backoffLevel) → { shouldFallback, cooldownMs, newBackoffLevel? }` — match rules top-to-bottom
- `getModelLockKey(model) → "modelLock_<model>" | "modelLock___all"`
- `isModelLockActive(account, model)` — check the specific model lock or the account-level lock
- `getEarliestModelLockUntil(account)` — for UI cooldown display
- `buildModelLockUpdate(model, cooldownMs) → { [key]: ISOTimestamp }`
- `buildClearModelLocksUpdate(account)` — null-out all `modelLock_*` keys
- `formatRetryAfter(iso) → "reset after Xm Ys"`

### `accountsStore.js` modifications

**New per-account fields** (all optional, additive — no migration needed):
- `modelLock_<model>`: ISO timestamp when this model becomes available again
- `modelLock___all`: ISO timestamp for account-level lock (when no model context known)
- `backoffLevel`: int, current exponential backoff level for rate-limit errors
- `errorCode`: last HTTP status from upstream
- `lastErrorAt`: ISO timestamp of last failure (this field already exists on the account record — see `lib/accountsStore.js:152-153`)

**`updateAccount` whitelist** (`lib/accountsStore.js:251-267`) currently restricts which keys can be written. It needs to admit `modelLock_*` (any prefixed key), `backoffLevel`, and `errorCode`. Add either:
- a wildcard match for `key.startsWith("modelLock_")` plus the two new scalar keys, OR
- a dedicated `updateAccountFlags(id, flags)` helper that uses `mutate` directly without going through `updateAccount`

Recommendation: dedicated helper to keep the public `updateAccount` schema explicit. `pickActiveAccount`, `markAccountUnavailable`, and `clearAccountError` use the helper directly.

**Mutex** — `accountsStore` already has a module-scope `LocalMutex` used by `withFileLock`. The pick must be atomic with the `lastUsedAt` write to prevent two concurrent picks from racing on LRU order. Solution: implement `pickActiveAccount` as a single `mutate(...)` call so the read, sort, and `lastUsedAt` write share one lock acquisition.

**`pickActiveAccount({ excludeIds = new Set(), model = null, preferredAccountId = null })`:** signature changes from the current array-only arg. Existing callers (none other than `proxy.js`) get updated.

1. Inside `mutate`:
2. Read accounts list
3. Filter: `isActive === true`, not in `excludeIds`, `!isModelLockActive(account, model)`
4. If empty:
   - If any of the original accounts (before exclude+lock filter) has an active model lock for this model, return `{ allLocked: true, retryAfter, retryAfterHuman, lastError, lastErrorCode }` — `retryAfter` derived from `getEarliestModelLockUntil` across model-locked accounts
   - Else return `null` (no active accounts at all, or all already excluded for this request)
5. If `preferredAccountId` is in the eligible set, choose it
6. Otherwise: LRU pick — sort by `lastUsedAt` ascending (nulls first), tiebreak by `createdAt` ascending. This matches the existing default (`settings.roundRobin === true`) behavior.
7. Update chosen account's `lastUsedAt` in the same `mutate` call
8. Return the chosen account (copy)

Note: `settings.roundRobin === false` (sticky-by-creation) is no longer relevant once preferredAccountId provides true session affinity. The setting can stay as a no-op or be deprecated — recommend leaving it alone in this spec to avoid expanding scope.

**`markAccountUnavailable(accountId, status, errText, model, resetsAtMs = null)`:**

1. Read account
2. If `resetsAtMs && resetsAtMs > Date.now()`: cooldown = `min(resetsAtMs - now, MAX_RATE_LIMIT_COOLDOWN_MS)`, `newBackoffLevel = 0` (precise reset trumps backoff)
3. Else: `{ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errText, account.backoffLevel || 0)`
4. If `!shouldFallback`: return `{ shouldFallback: false, cooldownMs: 0 }`
5. Persist: `{ ...buildModelLockUpdate(model, cooldownMs), errorCode: status, lastError: errText.slice(0,100), lastErrorAt: now, backoffLevel: newBackoffLevel ?? backoffLevel }`
6. Return `{ shouldFallback: true, cooldownMs }`

**`clearAccountError(accountId, model)`:**

1. Read account
2. Compute `keysToClear`:
   - `modelLock_<model>` (the model that just succeeded)
   - `modelLock___all`
   - Any `modelLock_*` whose timestamp is in the past (lazy cleanup)
3. If still has active locks after clearing, only null those keys
4. Else null those keys + reset `errorCode`, `lastError`, `lastErrorAt`, `backoffLevel: 0`

### `proxy.js` modifications

In both `handleMessages` and `handleChatCompletions`, replace `runWithFailover(...)` body with:

```js
async function runWithFailover(config, clientRes, attempt, ctx) {
  if (config.apiKey) {
    return attempt({ client: createApiKeyClient(config), account: null });
  }

  if ((await countAccounts()) === 0) {
    throw new Error("No Claude accounts configured. Add one from /dashboard/accounts.");
  }

  const sessionKey = ctx.sessionKey;
  let preferredAccountId = sessionKey ? sessionRoutes.getRoute(sessionKey) : null;
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
      const err = new Error(picked.lastError || "All accounts rate-limited");
      err.status = picked.lastErrorCode || 503;
      err.retryAfter = picked.retryAfter;
      throw err;
    }

    const account = await ensureFreshAccount(picked);

    try {
      const result = await attempt({ account, client: createClient(config, account.accessToken) });
      // success
      if (sessionKey) sessionRoutes.setRoute(sessionKey, account.id);
      await clearAccountError(account.id, ctx.model);
      return result;
    } catch (err) {
      // parse Anthropic's retry-after if present
      const resetsAtMs = parseRetryAfter(err);
      const { shouldFallback } = await markAccountUnavailable(
        account.id, err.status || 500, err.message, ctx.model, resetsAtMs
      );
      if (!shouldFallback || clientRes.headersSent) throw err;
      excludeIds.add(account.id);
      preferredAccountId = null;  // pin failed; fall through to strategy
      lastError = err;
      continue;
    }
  }
}
```

Wrap the call site in `handleMessages` / `handleChatCompletions` so that:
- `ctx.sessionKey = computeSessionKey(reqHeaders, reqBody, userToken?.id)` is set before the call
- `ctx.model` continues to be set inside `attempt` after `prepareBody`

`parseRetryAfter(err)` reads `err.headers?.["retry-after"]` (numeric seconds → epoch ms) or `err.error?.error?.retry_after` if the Anthropic SDK surfaces it. Returns `null` if not present.

### Dashboard surface for lock state

`/dashboard/accounts` page (`AccountDetailDialog.tsx` and listing): display per-model lock countdown.

Example UI text:
```
sonnet-3-5  · locked for 2m 30s
haiku-3-5   · clear
opus-3-5    · clear
```

Use `getEarliestModelLockUntil` + `formatRetryAfter` from `accountFallback.js`. Re-renders on poll interval (5 s) so admins can see locks expire.

## Edge cases

| Case | Behavior |
|---|---|
| Streaming response already started | `clientRes.headersSent === true` → re-throw, no fallback (existing behavior preserved) |
| API-key bypass mode | `userToken === null` → `sessionKey === null` → no sticky routing, existing flow |
| Pinned account deleted from dashboard | `pickActiveAccount` doesn't find it, falls through to strategy, route updated on success |
| Pinned account model-locked | Lock filter runs before pin lookup; pin can't override lock |
| Concurrent first-turn requests, same session_key | Mutex serializes pick; both writes to `setRoute`, last-write-wins. Stable from turn 2 |
| All accounts model-locked | `pickActiveAccount` returns `{ allLocked: true, ... }` → 503 with Retry-After |
| `accounts.json` schema migration | Additive optional fields, read with `?? null`. No script needed |
| Inspector log unbounded | Counter-based, stops at N. No timer |
| Empty `messages` array | All session-key candidates null → no routing. Account pick uses default strategy |
| Leaderboard sees emails of revoked tokens | Append-only history; old emails persist. Acceptable |

## Testing strategy

**Unit tests** using Node's stdlib `node:test` (no new dependency). Add `npm test` script.

- `lib/accountFallback.test.js`
  - `checkFallbackError`: 401 → fixed cooldown, no backoff increment; 429 → backoff; "rate limit" text → backoff regardless of status; status not in rules → transient default; resets_at override path
  - `getQuotaCooldown`: level 1 = 2s, level 2 = 4s, level 5 = 32s, capped at 5min
  - `isModelLockActive`: lock in past = false; lock in future = true; account-level lock blocks any model
  - `buildModelLockUpdate` / `buildClearModelLocksUpdate` round-trip

- `lib/sessionRoutes.test.js`
  - `setRoute` then `getRoute` returns same accountId
  - `getRoute` after TTL returns null (use injected clock or short TTL)
  - `setRoute` with null sessionKey is no-op
  - Prune removes idle, keeps recent

- `lib/sessionKey.test.js`
  - Header `x-claude-session-id` wins over `metadata.user_id`
  - `metadata.user_id` wins over `firstMessageHash`
  - Without `userTokenId` → null
  - First-message hash is stable across calls with same `messages[0]`
  - First-message hash differs when `messages[0]` differs

**Integration smoke (manual)**:
- Two test accounts (one valid, one with `accessToken=invalid`)
- Send 3 sequential `/v1/messages` requests with same `messages[0]` and same bearer token
- Verify all 3 use the same `account_id` in `request_logs`
- Force pin to bad account by manually calling `sessionRoutes.setRoute`; send request
- Verify fallback: bad account marked unavailable, request succeeds on good account, session re-pinned
- Send another request; verify it sticks to the good account

**Regression checks**:
- API-key bypass mode (`ANTHROPIC_API_KEY` set) still works end-to-end
- `/dashboard/usage` aggregates unchanged (no `request_logs` schema change)
- Token refresh cron still runs every 30 min
- Existing `/dashboard/accounts`, `/dashboard/tokens`, `/dashboard/logs` pages all load

**Inspector validation**:
- Set `INSPECT_REQUESTS=5`, restart proxy
- Run 5 real Claude Code requests against the proxy
- Read `~/.claude-server/request-inspect.log` — confirm headers + metadata structure
- Update `computeSessionKey` candidate list to match observed reality
- Remove `INSPECT_REQUESTS` env var

## Rollout

Phase 1 (leaderboard) ships independently — no behavioral risk to the proxy path.

Phase 2 (routing + fallback) is one PR that updates `pickActiveAccount`'s signature and its only caller (`proxy.js`) together. Behavioral safety properties:
- When `sessionKey === null` (API-key mode, empty messages, etc.) the system degrades to LRU — same effective behavior as today
- When no model lock has ever been set, the model-lock filter is a no-op
- Inspector is opt-in via `INSPECT_REQUESTS` env var; default is no logging

After production capture and identifier finalization, a small follow-up PR simplifies `computeSessionKey` to the verified identifier and removes the inspector code.
