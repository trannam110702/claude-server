import http from "node:http";
import readline from "node:readline";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CLAUDE_CLIENT_ID,
  generateAuthData,
  exchangeCode,
} from "./claudeOAuth.js";
import { countAccounts, createAccount, migrateFromSqlite } from "./accountsStore.js";

const TOKENS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "tokens.json");

/**
 * One-shot bootstrap migrations:
 *  1. Import any rows from a pre-existing SQLite claude_accounts table.
 *  2. If a legacy tokens.json file exists and the JSON store is empty, import it.
 * Both operations are idempotent.
 */
export async function bootstrapAccounts() {
  await migrateFromSqlite();

  if (!existsSync(TOKENS_PATH)) return null;
  if ((await countAccounts()) > 0) {
    try {
      unlinkSync(TOKENS_PATH);
      console.log("[migrate] removed stale tokens.json (accounts already populated)");
    } catch {}
    return null;
  }

  let tokens;
  try {
    tokens = JSON.parse(readFileSync(TOKENS_PATH, "utf-8"));
  } catch {
    return null;
  }
  if (!tokens?.accessToken) return null;

  const account = await createAccount({
    name: "Imported account",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || null,
    expiresAt: tokens.expiresAt || null,
  });

  try {
    unlinkSync(TOKENS_PATH);
  } catch {}
  console.log(`[migrate] imported tokens.json into account ${account.id} and removed the file`);
  return account;
}

const CALLBACK_PORT = parseInt(process.env.OAUTH_CALLBACK_PORT || "0");

async function startCallbackServer() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(CALLBACK_PORT, "0.0.0.0", () => {
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

export async function login() {
  console.log("Starting Claude OAuth login flow...\n");

  const { server, port } = await startCallbackServer();
  const redirectUri = `http://localhost:${port}/callback`;

  const auth = generateAuthData(redirectUri);

  console.log("Opening browser for authorization...");
  console.log(`If browser doesn't open, visit:\n${auth.authUrl}\n`);

  const { exec } = await import("node:child_process");
  const openCmd = process.platform === "darwin" ? "open" :
                  process.platform === "win32" ? "start" : "xdg-open";
  exec(`${openCmd} "${auth.authUrl}"`);

  console.log("Waiting for authorization...");

  const { code, state: returnedState } = await waitForCallback(server);
  if (returnedState !== auth.state) {
    throw new Error("OAuth state mismatch — possible CSRF attack");
  }

  console.log("Authorization code received, exchanging for tokens...");

  const tokens = await exchangeCode({
    code,
    redirectUri,
    codeVerifier: auth.codeVerifier,
    state: auth.state,
  });

  const account = await createAccount({
    name: "CLI login",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scope: tokens.scope,
  });

  console.log(`\nAccount saved (id ${account.id})`);
  console.log(`Access token: ${tokens.accessToken.slice(0, 25)}...`);
  if (tokens.refreshToken) {
    console.log(`Refresh token: ${tokens.refreshToken.slice(0, 25)}...`);
  }
  if (tokens.expiresAt) {
    console.log(`Expires at: ${tokens.expiresAt}`);
  }
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function setup() {
  console.log("Manual token setup for headless/CLI-only servers\n");

  let accessToken = process.argv[3] || "";
  let refreshToken = process.argv[4] || "";

  if (!accessToken) accessToken = await prompt("Access token: ");
  if (!refreshToken) refreshToken = await prompt("Refresh token: ");

  if (!accessToken || !refreshToken) {
    console.error("Both access token and refresh token are required.");
    process.exit(1);
  }

  const account = await createAccount({
    name: "Manual setup",
    accessToken,
    refreshToken,
    expiresAt: null,
  });

  console.log(`\nAccount saved (id ${account.id})`);
  console.log(`Access token: ${accessToken.slice(0, 25)}...`);
  console.log(`Refresh token: ${refreshToken.slice(0, 25)}...`);
}

export { CLAUDE_CLIENT_ID };
