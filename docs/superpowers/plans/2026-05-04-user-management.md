# User Management v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/dashboard/users` page that lists every Google sign-in and lets admins toggle `is_admin` per user, layered on top of the existing seed/env admin allowlist.

**Architecture:** A `users` table is added to the existing better-sqlite3 DB (`lib/db.js`). A NextAuth `events.signIn` handler upserts the row on every login. `isAdmin(email)` becomes a union: hardcoded `SEED_ADMINS` ∪ `ADMIN_EMAILS` env var ∪ DB `is_admin=1`. Two API routes (admin-only) plus a server-gated dashboard page round it out.

**Tech Stack:** better-sqlite3 (existing), Auth.js v5 / NextAuth, Next.js 15 App Router, React 19, shadcn/ui (Switch, Table, Badge, Tooltip), node:test for unit tests.

**Reference:** `docs/superpowers/specs/2026-05-04-user-management-design.md`

---

## File map

**Create:**
- `lib/users.js` — schema migration + DB helpers (`upsertUserOnLogin`, `listUsers`, `isAdminInDb`, `setAdminInDb`)
- `lib/users.test.js` — node:test unit tests (temp sqlite DB, like `lib/db.test.js`)
- `next-app/app/api/users/route.ts` — `GET /api/users`
- `next-app/app/api/users/[email]/route.ts` — `PATCH /api/users/[email]`
- `next-app/app/dashboard/users/page.tsx` — server shell with admin gate
- `next-app/app/dashboard/users/UsersTable.tsx` — client table with toggle

**Modify:**
- `next-app/lib/db.ts` — re-export users helpers + add `DashboardUser` type
- `next-app/lib/admin.ts` — `isAdmin` becomes union (seed ∪ env ∪ DB)
- `next-app/auth.ts` — add `events.signIn` upsert handler
- `next-app/app/dashboard/components/Sidebar.tsx` — add admin-only "Users" link

---

## Task 1: Schema + `upsertUserOnLogin` (TDD)

**Files:**
- Create: `lib/users.js`
- Create: `lib/users.test.js`

The schema migration runs when `getDb()` is first called. We piggyback on the existing `getDb()` so we don't open a second connection — but we need to add a `CREATE TABLE` call. Since `initSchema()` in `lib/db.js` is private, we'll add the users table there too.

- [ ] **Step 1: Write failing test for `upsertUserOnLogin` first-call behavior**

Create `lib/users.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-server-users-test-"));
process.env.DATABASE_PATH = path.join(tmpDir, "test.db");

const { getDb } = await import("./db.js");
const { upsertUserOnLogin, listUsers, isAdminInDb, setAdminInDb } = await import("./users.js");

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern="upsertUserOnLogin inserts" lib/users.test.js`
Expected: FAIL — `Cannot find package 'users.js'` or similar (module doesn't exist).

- [ ] **Step 3: Add the `users` table to `lib/db.js` `initSchema`**

In `lib/db.js`, inside `initSchema(database)` after the `request_logs` block, append:

```js
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      email          TEXT PRIMARY KEY,
      name           TEXT,
      image          TEXT,
      is_admin       INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL,
      last_login_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_users_last_login ON users(last_login_at);
  `);
```

- [ ] **Step 4: Implement `upsertUserOnLogin` and `listUsers` in `lib/users.js`**

Create `lib/users.js`:

```js
import { getDb } from "./db.js";

/**
 * Insert a row on first sign-in; on subsequent sign-ins bump last_login_at and
 * refresh name/image (Google profile may change). created_at and is_admin are
 * preserved across calls.
 */
export function upsertUserOnLogin({ email, name = null, image = null }) {
  if (!email) return;
  const e = String(email).toLowerCase();
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(`
    INSERT INTO users (email, name, image, is_admin, created_at, last_login_at)
    VALUES (@email, @name, @image, 0, @now, @now)
    ON CONFLICT(email) DO UPDATE SET
      name = excluded.name,
      image = excluded.image,
      last_login_at = excluded.last_login_at
  `).run({ email: e, name, image, now });
}

function rowToUser(r) {
  return {
    email: r.email,
    name: r.name,
    image: r.image,
    isAdmin: r.is_admin === 1,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  };
}

export function listUsers() {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM users ORDER BY last_login_at DESC`)
    .all()
    .map(rowToUser);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test --test-name-pattern="upsertUserOnLogin inserts" lib/users.test.js`
Expected: PASS.

- [ ] **Step 6: Add second test — re-login bumps last_login_at, preserves created_at**

Append to `lib/users.test.js`:

```js
test("upsertUserOnLogin on re-login bumps last_login_at and preserves created_at", async () => {
  // First insert
  upsertUserOnLogin({ email: "bob@example.com", name: "Bob", image: null });
  const before = listUsers().find(u => u.email === "bob@example.com");
  // Wait 5ms to ensure timestamps differ
  await new Promise((r) => setTimeout(r, 5));
  upsertUserOnLogin({ email: "bob@example.com", name: "Robert", image: "http://b/x" });
  const after = listUsers().find(u => u.email === "bob@example.com");
  assert.equal(after.createdAt, before.createdAt, "created_at must not change");
  assert.notEqual(after.lastLoginAt, before.lastLoginAt, "last_login_at must update");
  assert.equal(after.name, "Robert", "name refreshed from new profile");
  assert.equal(after.image, "http://b/x", "image refreshed from new profile");
});
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --test --test-name-pattern="upsertUserOnLogin on re-login" lib/users.test.js`
Expected: PASS (the `ON CONFLICT` clause handles this — no implementation change).

- [ ] **Step 8: Add casing test**

Append to `lib/users.test.js`:

```js
test("upsertUserOnLogin lowercases email", () => {
  upsertUserOnLogin({ email: "Carol@Example.COM", name: "Carol", image: null });
  const row = listUsers().find(u => u.email === "carol@example.com");
  assert.ok(row, "expected lowercased email");
});
```

- [ ] **Step 9: Run all users tests**

Run: `node --test lib/users.test.js`
Expected: 3 passing.

- [ ] **Step 10: Commit**

```bash
git add lib/db.js lib/users.js lib/users.test.js
git commit -m "feat(users): add users table + upsertUserOnLogin helper"
```

---

## Task 2: `isAdminInDb` and `setAdminInDb` (TDD)

**Files:**
- Modify: `lib/users.js`
- Modify: `lib/users.test.js`

- [ ] **Step 1: Write failing test for `isAdminInDb`**

Append to `lib/users.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/users.test.js`
Expected: 4 new tests fail with `isAdminInDb is not a function` (or similar).

- [ ] **Step 3: Implement `isAdminInDb` and `setAdminInDb`**

Append to `lib/users.js`:

```js
export function isAdminInDb(email) {
  if (!email) return false;
  const e = String(email).toLowerCase();
  const db = getDb();
  const row = db.prepare(`SELECT is_admin FROM users WHERE email = ?`).get(e);
  return row?.is_admin === 1;
}

/**
 * Toggle the DB admin flag. Returns true on success, false if no row exists
 * for the email (callers should ensure the user has signed in at least once).
 * Note: seed/env admin protection is enforced at the API layer, not here.
 */
export function setAdminInDb(email, isAdmin) {
  if (!email) return false;
  const e = String(email).toLowerCase();
  const db = getDb();
  const result = db
    .prepare(`UPDATE users SET is_admin = ? WHERE email = ?`)
    .run(isAdmin ? 1 : 0, e);
  return result.changes > 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/users.test.js`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/users.js lib/users.test.js
git commit -m "feat(users): isAdminInDb + setAdminInDb helpers"
```

---

## Task 3: Re-export users helpers from `next-app/lib/db.ts`

**Files:**
- Modify: `next-app/lib/db.ts`

- [ ] **Step 1: Add re-exports and `DashboardUser` type**

In `next-app/lib/db.ts`, after the existing `userTokens.js` re-export block, append:

```ts
// @ts-ignore - JS module without bundled types
export {
  upsertUserOnLogin,
  listUsers,
  isAdminInDb,
  setAdminInDb,
} from "../../lib/users.js";

export interface DashboardUser {
  email: string;
  name: string | null;
  image: string | null;
  isAdmin: boolean;
  createdAt: string;
  lastLoginAt: string;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd next-app && npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add next-app/lib/db.ts
git commit -m "feat(users): re-export users helpers + DashboardUser type"
```

---

## Task 4: Union `isAdmin` (seed ∪ env ∪ DB)

**Files:**
- Modify: `next-app/lib/admin.ts`

- [ ] **Step 1: Update `isAdmin` to call `isAdminInDb`**

Replace the `isAdmin` function at the bottom of `next-app/lib/admin.ts` with:

```ts
import { isAdminInDb } from "./db";

const SEED_ADMINS = ["namtlv@avadagroup.com"];

function fromEnv() {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function getAdminEmails(): string[] {
  const set = new Set<string>([...SEED_ADMINS.map((e) => e.toLowerCase()), ...fromEnv()]);
  return Array.from(set);
}

/** True if email is in the hardcoded seed list. */
export function isSeedAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return SEED_ADMINS.map((e) => e.toLowerCase()).includes(email.toLowerCase());
}

/** True if email is in the ADMIN_EMAILS env var (excluding the seed list). */
export function isEnvAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return fromEnv().includes(email.toLowerCase());
}

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  if (isSeedAdmin(e) || isEnvAdmin(e)) return true;
  try {
    return isAdminInDb(e);
  } catch (err) {
    // DB is best-effort here; if it fails, fall back to seed/env only so we
    // never lock anyone out due to a DB hiccup.
    console.error("[admin] isAdminInDb threw:", (err as Error).message);
    return false;
  }
}
```

Keep the existing comment block at the top of the file unchanged.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd next-app && npx tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Smoke-test by booting the dev server and signing in**

Run: `npm run dev`
Open `http://localhost:3000/login`, sign in with the seed admin account. Verify the existing `/dashboard/accounts` admin-only badge/button still works (i.e. `isAdmin` still returns true via the seed path). Stop the dev server when satisfied.

- [ ] **Step 4: Commit**

```bash
git add next-app/lib/admin.ts
git commit -m "feat(users): isAdmin union of seed/env/DB; expose isSeedAdmin + isEnvAdmin"
```

---

## Task 5: NextAuth `events.signIn` upsert

**Files:**
- Modify: `next-app/auth.ts`

- [ ] **Step 1: Add `events.signIn` handler that upserts the user row**

In `next-app/auth.ts`, add `upsertUserOnLogin` to the import block and add an `events` block to the NextAuth config. The full file should look like:

```ts
import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { isAdmin } from "@/lib/admin";
import { upsertUserOnLogin } from "@/lib/db";

declare module "next-auth" {
  interface Session {
    user: {
      id?: string;
      isAdmin?: boolean;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    session({ session, token }) {
      if (session.user) {
        if (token.sub) session.user.id = token.sub;
        session.user.isAdmin = isAdmin(session.user.email);
      }
      return session;
    },
  },
  events: {
    // Record every successful sign-in. Failures here must not block sign-in
    // (transient DB errors shouldn't lock people out), so we log and swallow.
    async signIn({ user }) {
      if (!user?.email) return;
      try {
        upsertUserOnLogin({
          email: user.email,
          name: user.name ?? null,
          image: user.image ?? null,
        });
      } catch (err) {
        console.error("[auth] upsertUserOnLogin failed:", (err as Error).message);
      }
    },
  },
});
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd next-app && npx tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Smoke-test by signing out and back in**

Start the dev server (`npm run dev`), sign out, sign back in. Then in another shell:

```bash
sqlite3 ~/.claude-server/usage.db "SELECT email, name, is_admin, created_at, last_login_at FROM users;"
```

Expected: one row for the seed admin's email, `is_admin=0`, `created_at` and `last_login_at` both set.

- [ ] **Step 4: Commit**

```bash
git add next-app/auth.ts
git commit -m "feat(users): record every successful sign-in via events.signIn"
```

---

## Task 6: `GET /api/users` (admin-only)

**Files:**
- Create: `next-app/app/api/users/route.ts`

- [ ] **Step 1: Implement the route**

Create `next-app/app/api/users/route.ts`:

```ts
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { listUsers } from "@/lib/db";
import { isSeedAdmin, isEnvAdmin } from "@/lib/admin";

/**
 * GET /api/users
 *
 * Admin-only. Returns every recorded dashboard sign-in, sorted by last_login_at
 * desc. Each row carries server-computed `isSeedAdmin` / `isEnvAdmin` flags so
 * the UI can disable toggles for hardcoded admins without re-implementing the
 * allowlist logic on the client.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const rows = listUsers();
  const enriched = rows.map((u) => ({
    ...u,
    isSeedAdmin: isSeedAdmin(u.email),
    isEnvAdmin: isEnvAdmin(u.email),
  }));

  return NextResponse.json({ users: enriched });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd next-app && npx tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Smoke-test the route**

Start the dev server, sign in as the seed admin, then in browser devtools console (any logged-in tab):

```js
await fetch("/api/users").then(r => r.json());
```

Expected: `{ users: [{ email: "...", name: "...", isAdmin: false, isSeedAdmin: true, ... }] }`

- [ ] **Step 4: Commit**

```bash
git add next-app/app/api/users/route.ts
git commit -m "feat(users): GET /api/users (admin-only)"
```

---

## Task 7: `PATCH /api/users/[email]` with seed/env guard

**Files:**
- Create: `next-app/app/api/users/[email]/route.ts`

- [ ] **Step 1: Implement the route with seed/env protection**

Create `next-app/app/api/users/[email]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { setAdminInDb } from "@/lib/db";
import { isSeedAdmin, isEnvAdmin } from "@/lib/admin";

/**
 * PATCH /api/users/[email]
 *
 * Admin-only. Body: { isAdmin: boolean }. Email is lowercased before lookup.
 * Refuses to mutate seed/env admins (toggle is a no-op for those rows since
 * their admin status comes from elsewhere — fail loudly so the operator sees
 * what's happening instead of a silently-ignored write).
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ email: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { email: rawEmail } = await params;
  const email = decodeURIComponent(rawEmail).toLowerCase();

  let body: { isAdmin?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.isAdmin !== "boolean") {
    return NextResponse.json({ error: "isAdmin must be a boolean" }, { status: 400 });
  }

  if (isSeedAdmin(email) || isEnvAdmin(email)) {
    return NextResponse.json(
      {
        error:
          "Cannot modify hardcoded admin. Edit lib/admin.ts (seed) or ADMIN_EMAILS env var instead.",
      },
      { status: 400 }
    );
  }

  const ok = setAdminInDb(email, body.isAdmin);
  if (!ok) {
    return NextResponse.json(
      { error: "User not found. They must sign in at least once before being promoted." },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true, email, isAdmin: body.isAdmin });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd next-app && npx tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Smoke-test promotion and seed protection**

With dev server running and seed admin signed in, in browser devtools console (any logged-in tab):

```js
// Promote seed admin (should fail with 400 — seed protection)
await fetch("/api/users/" + encodeURIComponent("namtlv@avadagroup.com"), {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ isAdmin: false }),
}).then(r => r.json());
// Expected: { error: "Cannot modify hardcoded admin..." }

// Promote a non-existent user (should fail 404)
await fetch("/api/users/" + encodeURIComponent("ghost@example.com"), {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ isAdmin: true }),
}).then(r => r.json());
// Expected: { error: "User not found..." }
```

To exercise a successful promotion, sign in with a second Google account first (so a non-seed row exists), then PATCH that email.

- [ ] **Step 4: Commit**

```bash
git add next-app/app/api/users/[email]/route.ts
git commit -m "feat(users): PATCH /api/users/[email] with seed/env guard"
```

---

## Task 8: `/dashboard/users` page (server gate + client table)

**Files:**
- Create: `next-app/app/dashboard/users/page.tsx`
- Create: `next-app/app/dashboard/users/UsersTable.tsx`

- [ ] **Step 1: Create server page that gates on admin**

Create `next-app/app/dashboard/users/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { UsersTable } from "./UsersTable";

export default async function UsersPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!session.user.isAdmin) redirect("/dashboard");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-sm text-muted-foreground">
          Everyone who has signed into this dashboard. Toggle Admin to grant or
          revoke dashboard admin rights.
        </p>
      </div>
      <UsersTable />
    </div>
  );
}
```

- [ ] **Step 2: Create the client table component**

Create `next-app/app/dashboard/users/UsersTable.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface UserRow {
  email: string;
  name: string | null;
  image: string | null;
  isAdmin: boolean;
  isSeedAdmin: boolean;
  isEnvAdmin: boolean;
  createdAt: string;
  lastLoginAt: string;
}

function relative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 60_000) return "just now";
  const m = Math.floor(diffMs / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function UsersTable() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [busyEmail, setBusyEmail] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/users", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load users");
      setUsers(data.users);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function toggle(email: string, next: boolean) {
    setBusyEmail(email);
    // Optimistic
    setUsers((curr) =>
      curr.map((u) => (u.email === email ? { ...u, isAdmin: next } : u))
    );
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(email)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isAdmin: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Toggle failed");
    } catch (err) {
      // Roll back
      setUsers((curr) =>
        curr.map((u) => (u.email === email ? { ...u, isAdmin: !next } : u))
      );
      alert((err as Error).message);
    } finally {
      setBusyEmail(null);
    }
  }

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.email.toLowerCase().includes(q) ||
        (u.name ?? "").toLowerCase().includes(q)
    );
  }, [users, filter]);

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <Input
          placeholder="Search by email or name…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-sm"
        />

        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        {!loading && !error && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Last login</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead className="text-right">Admin</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                    No users match.
                  </TableCell>
                </TableRow>
              )}
              {filtered.map((u) => {
                const locked = u.isSeedAdmin || u.isEnvAdmin;
                const lockReason = u.isSeedAdmin
                  ? "Hardcoded in lib/admin.ts"
                  : "Set via ADMIN_EMAILS env var";
                return (
                  <TableRow key={u.email}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        {u.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={u.image} alt="" className="h-8 w-8 rounded-full" />
                        ) : (
                          <div className="h-8 w-8 rounded-full bg-muted" />
                        )}
                        <div>
                          <div className="text-sm font-medium">{u.name || u.email}</div>
                          <div className="text-xs text-muted-foreground flex items-center gap-2">
                            <span>{u.email}</span>
                            {u.isSeedAdmin && <Badge variant="secondary">seed admin</Badge>}
                            {u.isEnvAdmin && !u.isSeedAdmin && <Badge variant="secondary">env admin</Badge>}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{relative(u.lastLoginAt)}</TableCell>
                    <TableCell className="text-sm">{new Date(u.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell className="text-right">
                      <div title={locked ? lockReason : undefined} className="inline-flex">
                        <Switch
                          checked={u.isAdmin || locked}
                          disabled={locked || busyEmail === u.email}
                          onCheckedChange={(next) => toggle(u.email, next)}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd next-app && npx tsc --noEmit`
Expected: no output.

- [ ] **Step 4: Smoke-test the page**

Start the dev server, sign in as seed admin, navigate to `http://localhost:3000/dashboard/users`. Verify:
- Page loads with the seed admin row visible
- "seed admin" badge appears next to the email
- The Admin switch is shown ON and disabled (with hover tooltip)
- Search filter narrows the list

- [ ] **Step 5: Commit**

```bash
git add next-app/app/dashboard/users/page.tsx next-app/app/dashboard/users/UsersTable.tsx
git commit -m "feat(users): /dashboard/users page with admin toggle"
```

---

## Task 9: Sidebar link (admin-only)

**Files:**
- Modify: `next-app/app/dashboard/components/Sidebar.tsx`

- [ ] **Step 1: Add admin-only nav item**

Edit `next-app/app/dashboard/components/Sidebar.tsx`. Update the lucide import line to add `UserCog`:

```tsx
import { Home, BarChart3, BookOpen, FileText, HeartPulse, KeyRound, LogOut, Users, Trophy, UserCog } from "lucide-react";
```

Replace the `navItems` array and the rendering loop with admin-aware logic. The new file body (above the `export function Sidebar`) becomes:

```tsx
const navItems = [
  { href: "/dashboard", label: "Overview", icon: Home, adminOnly: false },
  { href: "/dashboard/accounts", label: "Accounts", icon: Users, adminOnly: false },
  { href: "/dashboard/tokens", label: "API tokens", icon: KeyRound, adminOnly: false },
  { href: "/dashboard/docs", label: "Setup guide", icon: BookOpen, adminOnly: false },
  { href: "/dashboard/users", label: "Users", icon: UserCog, adminOnly: true },
  { href: "/dashboard/usage", label: "Usage", icon: BarChart3, adminOnly: false },
  { href: "/dashboard/leaderboard", label: "Leaderboard", icon: Trophy, adminOnly: false },
  { href: "/dashboard/logs", label: "Logs", icon: FileText, adminOnly: false },
  { href: "/dashboard/health", label: "Health", icon: HeartPulse, adminOnly: false },
];
```

Then in the JSX where `navItems.map` is, filter by admin first:

```tsx
        {navItems
          .filter((item) => !item.adminOnly || session?.user?.isAdmin)
          .map((item) => {
```

(Leave the rest of the `.map` body unchanged.)

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd next-app && npx tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Smoke-test**

Start dev server, sign in as seed admin → "Users" link visible in sidebar. Sign in as a non-admin Google account → "Users" link hidden. Direct nav to `/dashboard/users` from a non-admin session redirects to `/dashboard`.

- [ ] **Step 4: Commit**

```bash
git add next-app/app/dashboard/components/Sidebar.tsx
git commit -m "feat(users): admin-only Users link in sidebar"
```

---

## Task 10: Manual end-to-end verification

This is verification only, no code changes. Don't skip it — TypeScript and unit tests don't catch UX regressions.

- [ ] **Step 1: Fresh DB run**

```bash
rm -f ~/.claude-server/usage.db
npm run dev
```

- [ ] **Step 2: Sign in as seed admin**

Open `http://localhost:3000`, sign in with the seed admin Google account.

Verify:
- `/dashboard/users` is reachable from the sidebar.
- Your row appears with "seed admin" badge.
- Admin switch is on + disabled.
- Hovering the switch shows the tooltip "Hardcoded in lib/admin.ts".

- [ ] **Step 3: Sign in a second account**

Sign out, sign in with a *different* Google account (a non-admin one).

Verify:
- The "Users" sidebar link is NOT visible.
- Direct navigation to `/dashboard/users` redirects to `/dashboard`.
- The middleware-level `/dashboard/accounts` page is still visible (read-only access).

- [ ] **Step 4: Promote the second account**

Sign back out, sign in as seed admin again. Go to `/dashboard/users`. The second account's row is now visible. Toggle their Admin switch ON.

Verify in another shell:
```bash
sqlite3 ~/.claude-server/usage.db "SELECT email, is_admin FROM users;"
```
Expected: second account has `is_admin=1`.

- [ ] **Step 5: Confirm role propagates**

Sign out, sign back in as the second account. The "Users" link should now be visible in the sidebar (since `isAdmin` returns true via DB).

- [ ] **Step 6: Demote the second account**

As seed admin again, toggle the second account's switch OFF. Sign in as them again — the "Users" link disappears.

- [ ] **Step 7: Verify env var path still works**

Stop the dev server. Add `ADMIN_EMAILS=temp@example.com` to `.env`. Restart. The seed admin still has access (seed list). If you have a `temp@example.com` Google account handy, sign in with it; verify the "Users" link is visible (env path), and verify the row in `/dashboard/users` shows "env admin" badge with disabled switch.

- [ ] **Step 8: Final commit if anything was tweaked during verification**

If verification surfaced any small fixes:
```bash
git add <files>
git commit -m "fix(users): <whatever>"
```

Otherwise nothing to commit — the verification step is a checkpoint, not a code change.

---

## Out of scope (deferred to future plans)

- Banning / disabling sign-in for a specific email (would add `disabled INTEGER` column + `signIn` callback rejection)
- Allowlist mode (closed dashboard — only pre-authorized emails can sign in)
- User row deletion from the page
- Audit log of admin role changes
- Roles beyond the binary admin/non-admin

These are all easy to add on top of this design without reshaping the data model.
