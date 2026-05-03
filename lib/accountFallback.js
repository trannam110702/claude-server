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
