import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const SCOPES = "org:create_api_key user:profile user:inference";

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

function generateState() {
  return crypto.randomBytes(16).toString("hex");
}

async function startCallbackServer() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, "localhost", () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

function waitForCallback(server) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timed out after 5 minutes"));
    }, 5 * 60 * 1000);

    server.on("request", (req, res) => {
      if (!req.url.startsWith("/callback")) return;
      const url = new URL(req.url, `http://localhost`);

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "Content-Type": "text/html" });
      if (error) {
        res.end("<h1>Authorization failed</h1><p>You can close this tab.</p>");
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
      } else if (code) {
        res.end("<h1>Authorization successful!</h1><p>You can close this tab and return to the terminal.</p>");
        clearTimeout(timeout);
        server.close();
        resolve({ code, state });
      } else {
        res.end("<h1>Unexpected request</h1>");
      }
    });
  });
}

async function exchangeCode(code, redirectUri, codeVerifier, state) {
  // Code may contain #state suffix
  let authCode = code;
  let codeState = "";
  if (authCode.includes("#")) {
    const parts = authCode.split("#");
    authCode = parts[0];
    codeState = parts[1] || "";
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      code: authCode,
      state: codeState || state,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

const TOKENS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "tokens.json");

export function readTokens() {
  try {
    return JSON.parse(readFileSync(TOKENS_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export function saveTokens(tokens) {
  const existing = readTokens() || {};
  const merged = { ...existing, ...tokens, updatedAt: new Date().toISOString() };
  writeFileSync(TOKENS_PATH, JSON.stringify(merged, null, 2));
}

export async function login() {
  console.log("Starting Claude OAuth login flow...\n");

  const { verifier, challenge } = generatePKCE();
  const state = generateState();

  const { server, port } = await startCallbackServer();
  const redirectUri = `http://localhost:${port}/callback`;

  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.searchParams.set("code", "true");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  console.log("Opening browser for authorization...");
  console.log(`If browser doesn't open, visit:\n${authUrl.toString()}\n`);

  // Open browser
  const { exec } = await import("node:child_process");
  const openCmd = process.platform === "darwin" ? "open" :
                  process.platform === "win32" ? "start" : "xdg-open";
  exec(`${openCmd} "${authUrl.toString()}"`);

  console.log("Waiting for authorization...");

  const { code, state: returnedState } = await waitForCallback(server);

  if (returnedState !== state) {
    throw new Error("OAuth state mismatch — possible CSRF attack");
  }

  console.log("Authorization code received, exchanging for tokens...");

  const tokens = await exchangeCode(code, redirectUri, verifier, state);

  saveTokens({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    clientId: CLIENT_ID,
    expiresAt: tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null,
  });

  console.log("\nTokens saved to tokens.json!");
  console.log(`Access token: ${tokens.access_token.slice(0, 25)}...`);
  console.log(`Refresh token: ${tokens.refresh_token.slice(0, 25)}...`);
  if (tokens.expires_in) {
    console.log(`Expires in: ${Math.round(tokens.expires_in / 60)} minutes`);
  }
}
