import { getDb } from "./db.js";

/**
 * Insert a row on first sign-in; on subsequent sign-ins bump last_login_at and
 * refresh name/image (Google profile may change). created_at and is_admin are
 * preserved across calls.
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
