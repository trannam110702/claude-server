/**
 * In-memory store for OAuth callbacks awaiting pickup by the dashboard modal.
 *
 * The /callback route writes here when Claude's redirect lands on our server
 * (which happens regardless of which Chrome profile the user authorized in,
 * since Claude redirects to http://localhost:8080/callback). The dashboard
 * modal polls /api/claude/oauth/poll?state=… to pick the entry up by state.
 *
 * Stored under globalThis so Next.js dev mode HMR doesn't wipe the Map between
 * /callback writes and /api/claude/oauth/poll reads.
 */

export interface PendingCallback {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;

declare global {
  // eslint-disable-next-line no-var
  var __claudeOauthPending: Map<string, PendingCallback> | undefined;
}

const store: Map<string, PendingCallback> =
  globalThis.__claudeOauthPending ?? (globalThis.__claudeOauthPending = new Map());

function gc() {
  const now = Date.now();
  for (const [key, value] of store) {
    if (value.expiresAt < now) store.delete(key);
  }
}

export function recordCallback(entry: Omit<PendingCallback, "expiresAt">) {
  gc();
  const key = entry.state || entry.code;
  if (!key) return;
  store.set(key, { ...entry, expiresAt: Date.now() + TTL_MS });
}

export function consumeCallback(state: string): PendingCallback | null {
  gc();
  const entry = store.get(state);
  if (!entry) return null;
  store.delete(state);
  return entry;
}
