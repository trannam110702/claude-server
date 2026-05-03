/**
 * Compute a session key for sticky account routing.
 *
 * Layered candidate strategy: prefer official identifiers over content-hash.
 * The exact identifiers Claude Code CLI emits are not yet confirmed; the
 * INSPECT_REQUESTS env var enables one-shot logging of real requests so the
 * candidate list can be trimmed once we have evidence.
 */
import crypto from "node:crypto";

export function firstMessageHash(body) {
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
