import { getDb } from "./db.js";

/**
 * Insert a row on first sign-in; on subsequent sign-ins bump last_login_at and
 * refresh name/image (Google profile may change). created_at and is_admin are
 * preserved across calls.
 *
 * @param {{ email: string, name?: string | null, image?: string | null }} args
 */
export function upsertUserOnLogin({ email, name = null, image = null }) {
  if (!email) throw new Error("upsertUserOnLogin: email is required");
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

/**
 * Pre-authorize a user before they've signed in. Inserts a row with the
 * given is_admin flag, name/image null, and created_at === last_login_at
 * (the UI uses that equality as a "never signed in" marker; their first
 * real upsertUserOnLogin will bump last_login_at past created_at).
 *
 * Returns { created: true } on insert, { created: false } if the email
 * already exists. Email is lowercased.
 *
 * @param {{ email: string, isAdmin?: boolean }} args
 */
export function inviteUser({ email, isAdmin = true }) {
  if (!email) throw new Error("inviteUser: email is required");
  const e = String(email).toLowerCase();
  const now = new Date().toISOString();
  const db = getDb();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO users
         (email, name, image, is_admin, created_at, last_login_at)
       VALUES (?, NULL, NULL, ?, ?, ?)`
    )
    .run(e, isAdmin ? 1 : 0, now, now);
  return { created: result.changes > 0 };
}

export function getUserPin(email) {
  if (!email) return null;
  const e = String(email).toLowerCase();
  const db = getDb();
  const row = db.prepare(`SELECT pinned_account_id FROM users WHERE email = ?`).get(e);
  return row?.pinned_account_id || null;
}

export function setUserPin(email, accountId) {
  if (!email) return false;
  const e = String(email).toLowerCase();
  const db = getDb();
  const result = db
    .prepare(`UPDATE users SET pinned_account_id = ? WHERE email = ?`)
    .run(accountId || null, e);
  return result.changes > 0;
}

export function clearUserPin(email) {
  return setUserPin(email, null);
}

/**
 * Return the user's pinned account id, picking and persisting one if none is
 * set or the existing pin is no longer in the candidate list.
 *
 * Picks the candidate with the oldest `lastUsedAt` (nulls first), breaking
 * ties on `createdAt`. Returns null if the user row doesn't exist or no
 * candidates were supplied.
 */
export function getOrAssignUserPin(email, candidates) {
  if (!email) return null;
  const e = String(email).toLowerCase();
  const db = getDb();
  const row = db.prepare(`SELECT pinned_account_id FROM users WHERE email = ?`).get(e);
  if (!row) return null;

  const candidateIds = new Set((candidates || []).map((c) => c.id));
  if (row.pinned_account_id && candidateIds.has(row.pinned_account_id)) {
    return row.pinned_account_id;
  }

  if (!candidates || candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => {
    const at = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
    const bt = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
    if (at !== bt) return at - bt;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
  const chosen = sorted[0];
  db.prepare(`UPDATE users SET pinned_account_id = ? WHERE email = ?`).run(chosen.id, e);
  return chosen.id;
}
