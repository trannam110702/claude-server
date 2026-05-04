# User Management v1 — Design

**Date:** 2026-05-04
**Status:** Approved (ready for implementation plan)
**Scope:** Add a dashboard page that lists Google sign-ins and lets admins toggle the admin role per user. DB-backed, layered on top of the existing seed/env allowlist.

---

## 1. Goals

- Replace "edit `ADMIN_EMAILS` and redeploy" with a UI toggle.
- Give operators visibility: a list of every email that has signed into the dashboard, when they joined, and when they last logged in.
- Preserve the existing break-glass paths (hardcoded `SEED_ADMINS` and `ADMIN_EMAILS` env var) so the system can never be locked out by DB state.

## 2. Non-goals (v1)

- **No ban / disable-login flag.** Sign-in remains open to any Google account.
- **No allowlist mode.** The dashboard is not closed by default.
- **No user deletion** from the page. Rows accumulate as people sign in.
- **No role system beyond `is_admin`.** Two states only: admin / non-admin.

These are deliberate omissions — easy to add later without reshaping the data model.

## 3. Architecture

Three additions, no rewrites:

```
┌─────────────────────────┐
│ next-app/auth.ts        │
│  events.signIn ─────────┼──► upsertUserOnLogin()
│  callbacks.session ─────┼──► isAdmin(email)
└─────────────────────────┘             │
                                        ▼
┌─────────────────────────┐    ┌─────────────────────┐
│ next-app/lib/admin.ts   │◄──►│ next-app/lib/users  │
│  isInSeed / isInEnv     │    │  upsertUserOnLogin  │
│  isAdmin = SEED ∪ ENV   │    │  listUsers          │
│            ∪ DB         │    │  setAdmin           │
│                         │    │  isAdminInDb        │
└─────────────────────────┘    └──────────┬──────────┘
                                          ▼
                              ┌──────────────────────┐
                              │ users table          │
                              │ (better-sqlite3 in   │
                              │  lib/db.js)          │
                              └──────────────────────┘
```

- **`users` table** in the existing SQLite (`lib/db.js`). Same DB that already holds `request_logs` and `user_tokens` — no new storage layer, no new lockfile.
- **NextAuth `events.signIn`** in `next-app/auth.ts`: upserts the user row (email, name, image, `last_login_at`, `created_at` if first time).
- **`isAdmin()` becomes a union:** seed list ∪ env var ∪ DB flag. The seed/env paths stay exactly as they are today; DB is purely additive.

## 4. Data model

```sql
CREATE TABLE users (
  email          TEXT PRIMARY KEY,        -- lowercased on write
  name           TEXT,                    -- from Google profile
  image          TEXT,                    -- avatar URL
  is_admin       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,           -- ISO8601, set on first signin
  last_login_at  TEXT NOT NULL            -- ISO8601, updated on every signin
);
```

**Why email is the primary key:** `isAdmin()` already keys on email, it dedupes accidental re-signins, and it survives a hypothetical provider switch (Google `sub` does not).

**Migration:** added next to the existing `CREATE TABLE IF NOT EXISTS` blocks in `lib/db.js`. No data migration — table starts empty and fills on next sign-in. The seed admin's row is created automatically the next time they log in; until then they remain admin via the seed list.

## 5. Sign-in recording

In `next-app/auth.ts`, add an `events.signIn` handler:

```ts
events: {
  async signIn({ user }) {
    if (!user.email) return;
    upsertUserOnLogin({
      email: user.email.toLowerCase(),
      name: user.name ?? null,
      image: user.image ?? null,
    });
  }
}
```

`upsertUserOnLogin` (in `next-app/lib/users.ts`) uses `INSERT … ON CONFLICT(email) DO UPDATE` to atomically:

- On first signin: set `created_at` and `last_login_at` to `now()`, store name/image, `is_admin=0`.
- On subsequent signins: bump `last_login_at`, refresh `name` and `image` (Google profile may change), leave `created_at` and `is_admin` alone.

Failures here must NOT block sign-in (a transient DB write error shouldn't lock people out). The handler logs and swallows.

## 6. `isAdmin` union

`next-app/lib/admin.ts` stays as-is. Add a thin `isAdminInDb(email)` helper to `next-app/lib/users.ts` and rewrite the public `isAdmin` to:

```ts
export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  return isInSeed(e) || isInEnv(e) || isAdminInDb(e);
}
```

`isAdminInDb` reads via the shared `getDb()` from `lib/db.js` (better-sqlite3 is synchronous, fits the existing `session()` callback).

## 7. API routes

Two new routes under `next-app/app/api/users/`:

### `GET /api/users`
- Auth: `auth()` + `isAdmin(session.user.email)` — admin-only.
- Response: `[{ email, name, image, isAdmin, isSeedAdmin, isEnvAdmin, createdAt, lastLoginAt }, ...]` sorted by `last_login_at DESC`.
- `isSeedAdmin` / `isEnvAdmin` are server-computed flags so the UI can disable the toggle and show the right badge without re-implementing the allowlist logic on the client.

### `PATCH /api/users/[email]`
- Auth: admin-only.
- Body: `{ isAdmin: boolean }`.
- Path param is lowercased before lookup.
- Refuses with 400 if the target email is in `SEED_ADMINS` or `ADMIN_EMAILS` and the request tries to set `isAdmin=false` (consistent with the UI disabling the toggle — defense in depth).
- No "last admin" guard: the seed list is always non-empty, so demoting the last DB admin can never lock the system.

## 8. UI page

New route: `next-app/app/dashboard/users/page.tsx`, following `dashboard/accounts/page.tsx`:

- **Table columns:** Avatar | Name + email | Last login (relative — "3h ago") | Joined date | Admin toggle
- **Admin toggle:** Switch component with optimistic update, rollback + toast on error.
- **Search input:** filters client-side by email/name substring.
- **Badges next to email:**
  - "seed admin" if `isSeedAdmin` (toggle disabled, tooltip explains it's hardcoded in `lib/admin.ts`)
  - "env admin" if `isEnvAdmin` (toggle disabled, tooltip explains it's set via `ADMIN_EMAILS`)
- **Sidebar:** add "Users" link in `dashboard/components/Sidebar.tsx`, gated on `session.user.isAdmin` (existing pattern).

The page is listed under the existing admin-only sidebar group; non-admin sessions never see the link, and direct navigation to `/dashboard/users` redirects via the existing layout guard.

## 9. Edge cases & decisions

| Case | Behavior |
|------|----------|
| Seed admin signs in for the first time | Row inserted with `is_admin=0`. They're still admin via seed. UI shows them disabled with "seed admin" badge. |
| Operator toggles a seed admin off in the UI | Defense-in-depth: API rejects with 400. UI never sends this (toggle is disabled). |
| User signs in, gets recorded, gets promoted to admin, leaves company | Operator demotes them via UI. Their row stays (visibility is the point). |
| `ADMIN_EMAILS` env var changes between sign-ins | `isEnvAdmin` is recomputed every request from `process.env`, so changes take effect immediately without a DB write. |
| Two browser tabs toggle the same user concurrently | Last write wins (better-sqlite3 is synchronous + single-process here). Acceptable — admin actions are low-frequency. |
| `events.signIn` write fails | Logged, swallowed. Sign-in succeeds. The user shows up in the list on their next successful login. |
| When does a role change take effect? | Immediately on the demoted/promoted user's next request. The NextAuth `session` callback runs `isAdmin(email)` on every session check, so the union (seed ∪ env ∪ DB) is re-evaluated each time. No JWT refresh needed. |

## 10. Testing

- **Unit (`next-app/lib/users.test.ts`):**
  - `upsertUserOnLogin` inserts on first call, bumps `last_login_at` + refreshes name/image on second.
  - `isAdminInDb` returns true only when `is_admin=1`.
  - `setAdmin(email, false)` throws when email is in `SEED_ADMINS` or `ADMIN_EMAILS`.
- **Unit (`next-app/lib/admin.test.ts`):**
  - `isAdmin` is true via seed alone, env alone, DB alone, and any combination.
  - Casing is normalized.
- **Integration:** add a seed sqlite fixture in tests that covers a sign-in event end-to-end (upsert → list → toggle → list).
- No e2e for the page itself in v1; manual verification on the dev server (golden path: sign in as seed admin, see your row appear, toggle a non-admin, see role propagate on their next request).

## 11. Implementation order (for the plan skill)

1. Schema + `next-app/lib/users.ts` (DB helpers + tests).
2. Wire `isAdmin` to the new helper in `next-app/lib/admin.ts`.
3. `events.signIn` upsert in `next-app/auth.ts`.
4. API routes (`/api/users`, `/api/users/[email]`).
5. `/dashboard/users` page + sidebar link.
6. Manual verification on dev server.
