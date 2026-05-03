/**
 * Claude accounts store — JSON file backed, multi-process safe.
 *
 * Mirrors 9router's localDb pattern: a single JSON file under the user's
 * home directory, every read re-reads the file from disk, every write
 * takes a cross-process lock via proper-lockfile. This sidesteps SQLite
 * per-connection caching / WAL snapshot semantics that were causing the
 * Express proxy and the Next.js routes to see different data.
 */
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import lockfile from "proper-lockfile";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

const DATA_DIR = resolveDataDir();
const DB_FILE = path.join(DATA_DIR, "accounts.json");

const DEFAULT_SETTINGS = { roundRobin: true };

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ accounts: [], settings: { ...DEFAULT_SETTINGS } }, null, 2));
}

const LOCK_OPTIONS = {
  retries: { retries: 15, minTimeout: 50, maxTimeout: 3000 },
  stale: 10000,
};

class LocalMutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }
  async acquire() {
    if (!this._locked) {
      this._locked = true;
      return () => this._release();
    }
    return new Promise((resolve) => this._queue.push(resolve)).then(() => () => this._release());
  }
  _release() {
    const next = this._queue.shift();
    if (next) next();
    else this._locked = false;
  }
}

const localMutex = new LocalMutex();

let dbInstance = null;
function getLow() {
  if (!dbInstance) {
    dbInstance = new Low(new JSONFile(DB_FILE), { accounts: [], settings: { ...DEFAULT_SETTINGS } });
  }
  return dbInstance;
}

function ensureShape(data) {
  if (!data || typeof data !== "object") return { accounts: [], settings: { ...DEFAULT_SETTINGS } };
  if (!Array.isArray(data.accounts)) data.accounts = [];
  if (!data.settings || typeof data.settings !== "object") data.settings = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (data.settings[k] === undefined) data.settings[k] = v;
  }
  return data;
}

async function withFileLock(operation) {
  const releaseLocal = await localMutex.acquire();
  let release = null;
  try {
    release = await lockfile.lock(DB_FILE, LOCK_OPTIONS);
    return await operation();
  } finally {
    if (release) {
      try { await release(); } catch {}
    }
    releaseLocal();
  }
}

async function readDb() {
  const db = getLow();
  await withFileLock(async () => {
    try {
      await db.read();
    } catch (err) {
      if (err instanceof SyntaxError) {
        console.warn(`[accounts] corrupt JSON in ${DB_FILE}, resetting`);
        db.data = { accounts: [], settings: { ...DEFAULT_SETTINGS } };
        await db.write();
      } else {
        throw err;
      }
    }
    db.data = ensureShape(db.data);
  });
  return db;
}

async function mutate(fn) {
  const db = getLow();
  let result;
  await withFileLock(async () => {
    try {
      await db.read();
    } catch (err) {
      if (err instanceof SyntaxError) {
        db.data = { accounts: [], settings: { ...DEFAULT_SETTINGS } };
      } else {
        throw err;
      }
    }
    db.data = ensureShape(db.data);
    result = await fn(db.data);
    await db.write();
  });
  return result;
}

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   email: string | null,
 *   fullName: string | null,
 *   organizationName: string | null,
 *   organizationId: string | null,
 *   accountUuid: string | null,
 *   plan: string | null,
 *   accessToken: string,
 *   refreshToken: string | null,
 *   expiresAt: string | null,
 *   scope: string | null,
 *   isActive: boolean,
 *   lastUsedAt: string | null,
 *   lastError: string | null,
 *   lastErrorAt: string | null,
 *   createdAt: string,
 *   updatedAt: string,
 * }} ClaudeAccount
 */

/** @returns {Promise<ClaudeAccount[]>} */
export async function listAccounts() {
  const db = await readDb();
  return [...db.data.accounts];
}

/** @returns {Promise<ClaudeAccount | null>} */
export async function getAccount(id) {
  const db = await readDb();
  return db.data.accounts.find((a) => a.id === id) || null;
}

export async function countAccounts() {
  const db = await readDb();
  return db.data.accounts.length;
}

/**
 * @param {{
 *   name: string,
 *   email?: string | null,
 *   fullName?: string | null,
 *   organizationName?: string | null,
 *   organizationId?: string | null,
 *   accountUuid?: string | null,
 *   plan?: string | null,
 *   accessToken: string,
 *   refreshToken?: string | null,
 *   expiresAt?: string | null,
 *   scope?: string | null,
 *   isActive?: boolean,
 * }} input
 * @returns {Promise<ClaudeAccount>}
 */
export async function createAccount(input) {
  return mutate((data) => {
    const now = new Date().toISOString();
    const email = input.email ?? null;
    const profileFields = {
      fullName: input.fullName ?? null,
      organizationName: input.organizationName ?? null,
      organizationId: input.organizationId ?? null,
      accountUuid: input.accountUuid ?? null,
      plan: input.plan ?? null,
    };

    // Upsert by email when provided so re-adding refreshes tokens.
    if (email) {
      const existing = data.accounts.find((a) => a.email === email);
      if (existing) {
        existing.name = input.name;
        existing.accessToken = input.accessToken;
        existing.refreshToken = input.refreshToken ?? null;
        existing.expiresAt = input.expiresAt ?? null;
        existing.scope = input.scope ?? null;
        existing.isActive = input.isActive !== false;
        Object.assign(existing, profileFields);
        existing.lastError = null;
        existing.lastErrorAt = null;
        // Re-adding an account is the operator saying "this should work now" —
        // clear any prior fallback state so the new credentials aren't
        // immediately filtered out by isModelLockActive.
        existing.errorCode = null;
        existing.backoffLevel = 0;
        for (const key of Object.keys(existing)) {
          if (key.startsWith("modelLock_")) existing[key] = null;
        }
        existing.updatedAt = now;
        return { ...existing };
      }
    }

    /** @type {ClaudeAccount} */
    const account = {
      id: crypto.randomUUID(),
      name: input.name,
      email,
      ...profileFields,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken ?? null,
      expiresAt: input.expiresAt ?? null,
      scope: input.scope ?? null,
      isActive: input.isActive !== false,
      lastUsedAt: null,
      lastError: null,
      lastErrorAt: null,
      createdAt: now,
      updatedAt: now,
    };
    data.accounts.push(account);
    return { ...account };
  });
}

/** @returns {Promise<ClaudeAccount | null>} */
export async function updateAccount(id, fields) {
  return mutate((data) => {
    const account = data.accounts.find((a) => a.id === id);
    if (!account) return null;

    const allowed = [
      "name",
      "email",
      "fullName",
      "organizationName",
      "organizationId",
      "accountUuid",
      "plan",
      "accessToken",
      "refreshToken",
      "expiresAt",
      "scope",
      "isActive",
      "lastUsedAt",
      "lastError",
      "lastErrorAt",
    ];
    for (const key of allowed) {
      if (key in fields) account[key] = fields[key];
    }
    account.updatedAt = new Date().toISOString();
    return { ...account };
  });
}

/** @returns {Promise<boolean>} */
export async function deleteAccount(id) {
  return mutate((data) => {
    const before = data.accounts.length;
    data.accounts = data.accounts.filter((a) => a.id !== id);
    return data.accounts.length < before;
  });
}

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

export async function getSettings() {
  const db = await readDb();
  return { ...DEFAULT_SETTINGS, ...(db.data.settings || {}) };
}

/**
 * @param {Partial<{ roundRobin: boolean }>} patch
 * @returns {Promise<{ roundRobin: boolean }>}
 */
export async function updateSettings(patch) {
  return mutate((data) => {
    if (!data.settings) data.settings = { ...DEFAULT_SETTINGS };
    if (typeof patch.roundRobin === "boolean") data.settings.roundRobin = patch.roundRobin;
    return { ...DEFAULT_SETTINGS, ...data.settings };
  });
}

export async function markAccountUsed(id) {
  await mutate((data) => {
    const account = data.accounts.find((a) => a.id === id);
    if (!account) return;
    const now = new Date().toISOString();
    account.lastUsedAt = now;
    account.updatedAt = now;
  });
}

export async function markAccountError(id, error) {
  await mutate((data) => {
    const account = data.accounts.find((a) => a.id === id);
    if (!account) return;
    const now = new Date().toISOString();
    account.lastError = String(error || "").slice(0, 500);
    account.lastErrorAt = now;
    account.updatedAt = now;
  });
}

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
    account.lastError =
      typeof errText === "string"
        ? errText.slice(0, 200)
        : (errText?.message ? String(errText.message).slice(0, 200) : "Provider error");
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

/**
 * One-shot migration: import any pre-existing rows from the legacy SQLite
 * accounts table at <repo>/data/usage.db OR ~/.claude-server/usage.db.
 */
export async function migrateFromSqlite() {
  if ((await countAccounts()) > 0) return;

  const sqlitePaths = [
    path.join(DATA_DIR, "usage.db"),
    path.join(process.cwd(), "data", "usage.db"),
    path.join(process.cwd(), "..", "data", "usage.db"),
  ];

  for (const sqlitePath of sqlitePaths) {
    if (!fs.existsSync(sqlitePath)) continue;
    try {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(sqlitePath, { readonly: true });
      const exists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='claude_accounts'")
        .get();
      if (!exists) {
        db.close();
        continue;
      }
      const rows = db.prepare("SELECT * FROM claude_accounts").all();
      db.close();
      if (!rows.length) continue;

      await mutate((data) => {
        for (const row of rows) {
          data.accounts.push({
            id: row.id,
            name: row.name,
            email: row.email,
            accessToken: row.access_token,
            refreshToken: row.refresh_token,
            expiresAt: row.expires_at,
            scope: row.scope,
            isActive: !!row.is_active,
            lastUsedAt: row.last_used_at,
            lastError: row.last_error,
            lastErrorAt: row.last_error_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          });
        }
      });
      console.log(`[accounts] imported ${rows.length} account(s) from ${sqlitePath}`);
      return;
    } catch (err) {
      console.warn(`[accounts] sqlite migration from ${sqlitePath} skipped: ${err.message}`);
    }
  }
}

export const ACCOUNTS_DB_FILE = DB_FILE;
