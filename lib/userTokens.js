/**
 * User-issued access tokens — JSON file backed, multi-process safe.
 *
 * One Google-OAuth user can mint many tokens (e.g. one per API client).
 * Tokens are stored in plaintext so the dashboard can show / copy them at
 * any time (this is a self-hosted personal proxy; the JSON file lives in
 * ~/.claude-server/ behind the OS user). The proxy on :8080 validates the
 * Authorization: Bearer header against this store before forwarding.
 */
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import lockfile from "proper-lockfile";
import crypto from "node:crypto";
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

const DATA_DIR = resolveDataDir();
const DB_FILE = path.join(DATA_DIR, "userTokens.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ tokens: [] }, null, 2));

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
  if (!dbInstance) dbInstance = new Low(new JSONFile(DB_FILE), { tokens: [] });
  return dbInstance;
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
        db.data = { tokens: [] };
        await db.write();
      } else {
        throw err;
      }
    }
    if (!db.data || !Array.isArray(db.data.tokens)) {
      db.data = { tokens: [] };
      await db.write();
    }
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
        db.data = { tokens: [] };
      } else {
        throw err;
      }
    }
    if (!db.data || !Array.isArray(db.data.tokens)) {
      db.data = { tokens: [] };
    }
    result = await fn(db.data);
    await db.write();
  });
  return result;
}

const TOKEN_PREFIX = "cs_";

function generateRawToken() {
  return TOKEN_PREFIX + crypto.randomBytes(24).toString("base64url");
}

/**
 * @typedef {{
 *   id: string,
 *   userId: string,
 *   userEmail: string | null,
 *   name: string,
 *   secret: string,
 *   createdAt: string,
 *   lastUsedAt: string | null,
 *   revokedAt: string | null,
 * }} UserToken
 */

/**
 * @param {{ userId: string, userEmail?: string | null, name?: string }} input
 * @returns {Promise<UserToken>}
 */
export async function createToken({ userId, userEmail = null, name }) {
  if (!userId) throw new Error("userId required");
  const trimmed = (name || "").trim() || "API token";
  return mutate((data) => {
    /** @type {UserToken} */
    const token = {
      id: crypto.randomUUID(),
      userId,
      userEmail,
      name: trimmed,
      secret: generateRawToken(),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
    data.tokens.push(token);
    return { ...token };
  });
}

/** @returns {Promise<UserToken[]>} */
export async function listTokensForUser(userId) {
  const db = await readDb();
  return db.data.tokens
    .filter((t) => t.userId === userId)
    .map((t) => ({ ...t }))
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
}

/**
 * @returns {Promise<boolean>}
 */
export async function revokeToken(id, userId) {
  return mutate((data) => {
    const t = data.tokens.find((x) => x.id === id && x.userId === userId);
    if (!t || t.revokedAt) return false;
    t.revokedAt = new Date().toISOString();
    return true;
  });
}

/**
 * Validate an incoming bearer token; updates lastUsedAt on hit.
 * @param {string} secret
 * @returns {Promise<UserToken | null>}
 */
export async function validateToken(secret) {
  if (!secret || typeof secret !== "string") return null;
  if (!secret.startsWith(TOKEN_PREFIX)) return null;
  return mutate((data) => {
    const t = data.tokens.find((x) => x.secret === secret);
    if (!t || t.revokedAt) return null;
    t.lastUsedAt = new Date().toISOString();
    return { ...t };
  });
}

export const USER_TOKENS_DB_FILE = DB_FILE;
