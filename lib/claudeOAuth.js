import crypto from "node:crypto";
import { updateAccount } from "./accountsStore.js";

export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const CLAUDE_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
export const CLAUDE_SCOPES = ["org:create_api_key", "user:profile", "user:inference"];

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export function generatePKCE() {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");
  return { codeVerifier, codeChallenge, state };
}

export function buildAuthUrl(redirectUri, codeChallenge, state) {
  const url = new URL(CLAUDE_AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLAUDE_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", CLAUDE_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function generateAuthData(redirectUri) {
  const { codeVerifier, codeChallenge, state } = generatePKCE();
  return {
    authUrl: buildAuthUrl(redirectUri, codeChallenge, state),
    codeVerifier,
    codeChallenge,
    state,
    redirectUri,
  };
}

/**
 * Exchange an authorization code for tokens.
 * The code may carry "#state" suffix from Claude's redirect.
 */
export async function exchangeCode({ code, redirectUri, codeVerifier, state }) {
  let authCode = code;
  let codeState = "";
  if (authCode.includes("#")) {
    const parts = authCode.split("#");
    authCode = parts[0];
    codeState = parts[1] || "";
  }

  const response = await fetch(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLAUDE_CLIENT_ID,
      code: authCode,
      state: codeState || state,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }
  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    expiresAt: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null,
    scope: data.scope || null,
  };
}

export async function refreshAccessToken(refreshToken) {
  const response = await fetch(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLAUDE_CLIENT_ID,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Refresh failed (${response.status}): ${text}`);
  }
  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in,
    expiresAt: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null,
  };
}

/**
 * Refresh tokens for an account if it's near expiry, persist to DB,
 * and return the (possibly updated) account.
 */
export async function ensureFreshAccount(account) {
  if (!account || !account.refreshToken) return account;

  const expiresAtMs = account.expiresAt ? new Date(account.expiresAt).getTime() : 0;
  const needsRefresh = !expiresAtMs || expiresAtMs - Date.now() < REFRESH_BUFFER_MS;
  if (!needsRefresh) return account;

  try {
    const fresh = await refreshAccessToken(account.refreshToken);
    const updated = await updateAccount(account.id, {
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken,
      expiresAt: fresh.expiresAt,
      lastError: null,
      lastErrorAt: null,
    });
    return updated || account;
  } catch (err) {
    console.error(`[oauth] refresh failed for account ${account.id}: ${err.message}`);
    throw err;
  }
}
