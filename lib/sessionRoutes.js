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
  if (Date.now() - r.lastSeen >= TTL_MS) {
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
  for (const [k, v] of routes) if (v.lastSeen <= cutoff) routes.delete(k);
}

// Test hook
export function _setTtlForTests(ms) {
  TTL_MS = ms;
}

setInterval(_pruneNow, PRUNE_MS).unref();
