import http from "node:http";
import { handleMessages, handleChatCompletions, scheduledTokenRefresh } from "./lib/proxy.js";
import { bootstrapAccounts } from "./lib/login.js";
import { countAccounts } from "./lib/accountsStore.js";
import { validateToken as validateUserToken } from "./lib/userTokens.js";

// Handle CLI commands
if (process.argv[2] === "login") {
  const { login } = await import("./lib/login.js");
  await login();
  process.exit(0);
}

if (process.argv[2] === "setup") {
  const { setup } = await import("./lib/login.js");
  await setup();
  process.exit(0);
}

// One-shot bootstrap: import legacy SQLite/tokens.json data into the JSON store.
await bootstrapAccounts();

const config = {
  port: parseInt(process.env.PORT || "8080"),
  host: process.env.HOST || "127.0.0.1",
  baseUrl: (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, ""),
  apiKey: process.env.ANTHROPIC_API_KEY || null,
};

if (!config.apiKey && (await countAccounts()) === 0) {
  console.warn("No credentials yet. Sign in to /dashboard/accounts to add a Claude account, or run 'npm run login'.");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => data += chunk);
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function readBodyRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Authenticate /v1/* requests with a user-issued bearer token.
 * Returns the matching token record on success, sends 401 and returns null
 * otherwise. ANTHROPIC_API_KEY (set via env) bypasses the check, since that
 * implies the operator already trusts the network.
 */
async function requireUserToken(req, res) {
  if (process.env.ANTHROPIC_API_KEY) return { bypass: true };

  const auth = req.headers["authorization"] || "";
  const match = auth.match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    res.writeHead(401, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({
      error: { type: "authentication_error", message: "Missing Authorization: Bearer <token> header" },
    }));
    return null;
  }
  const token = await validateUserToken(match[1]);
  if (!token) {
    res.writeHead(401, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({
      error: { type: "authentication_error", message: "Invalid or revoked token" },
    }));
    return null;
  }
  return token;
}

function handleCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  if (handleCors(req, res)) return;

  let path = req.url.split("?")[0].replace(/\/+$/, "").replace(/\/v1\/v1\//, "/v1/");

  console.log(`[${new Date().toISOString()}] ${req.method} ${path}`);

  // Proxy dashboard + auth + callback to Next.js (port 3000)
  if (
    path.startsWith("/dashboard") ||
    path === "/login" ||
    path === "/callback" ||
    path.startsWith("/_next") ||
    (path.startsWith("/api") && !path.startsWith("/v1"))
  ) {
    const targetUrl = new URL(`http://127.0.0.1:3000${path}`);
    targetUrl.search = req.url.split("?")[1] || "";

    try {
      const body = req.method !== "GET" && req.method !== "HEAD" ? await readBodyRaw(req) : undefined;
      const headers = { ...req.headers };
      // Hop-by-hop headers must not be forwarded; content-length is recomputed by fetch.
      for (const h of ["connection", "keep-alive", "transfer-encoding", "content-length", "upgrade", "proxy-authorization", "te", "trailer"]) {
        delete headers[h];
      }
      // Reverse-proxy headers so Next.js (and Auth.js with trustHost) can build
      // correct absolute URLs (redirect_uri, callback URLs) from the public host.
      const originalHost = req.headers.host || "";
      headers["x-forwarded-host"] = originalHost;
      headers["x-forwarded-proto"] = req.socket.encrypted ? "https" : "http";
      headers["x-forwarded-for"] = (req.headers["x-forwarded-for"] ? req.headers["x-forwarded-for"] + ", " : "") + (req.socket.remoteAddress || "");

      const response = await fetch(targetUrl.toString(), {
        method: req.method,
        headers,
        body: body && body.length ? body : undefined,
        signal: AbortSignal.timeout(30000),
        redirect: "manual",
      });

      // Build response headers, taking care to preserve multiple Set-Cookie values.
      // Headers.forEach() collapses repeated headers into one comma-joined string,
      // which is invalid for Set-Cookie (cookies use commas inside values), so we
      // pull set-cookie out via getSetCookie() and pass it as an array.
      const headerEntries = [];
      const setCookies = typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];

      response.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (lower === "content-encoding") return;
        if (lower === "set-cookie") return; // handled separately
        headerEntries.push([key, value]);
      });
      headerEntries.push(["Access-Control-Allow-Origin", "*"]);
      if (setCookies.length) headerEntries.push(["Set-Cookie", setCookies]);

      res.writeHead(response.status, headerEntries);
      const buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
    } catch (err) {
      if (err.code === "ECONNREFUSED" || err.cause?.code === "ECONNREFUSED") {
        res.writeHead(503, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Dashboard not available" }));
      } else {
        console.error("[proxy] dashboard error:", err.message);
        res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  try {
    if (path === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({
        status: "ok",
        auth: config.apiKey ? "api_key" : "oauth",
        accounts: await countAccounts(),
      }));
      return;
    }

    if (path === "/v1/messages" && req.method === "POST") {
      const userToken = await requireUserToken(req, res);
      if (!userToken) return;
      const body = await readBody(req);
      // proxy.js owns request-logs persistence (it has account/model/token context).
      await handleMessages(body, res, config, { userToken });
      return;
    }

    if (path === "/v1/chat/completions" && req.method === "POST") {
      const userToken = await requireUserToken(req, res);
      if (!userToken) return;
      const body = await readBody(req);
      await handleChatCompletions(body, res, config, { userToken });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: { message: "Not found", type: "invalid_request_error" } }));
  } catch (err) {
    console.error("[server] error:", err.message);
    if (!res.headersSent) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: { message: err.message, type: "invalid_request_error" } }));
    }
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Claude proxy server running at http://${config.host}:${config.port}`);
  console.log(`Auth method: ${config.apiKey ? "API key" : "OAuth (multi-account)"}`);
  console.log(`Endpoints:`);
  console.log(`  POST /v1/messages          - Claude native format (pass-through)`);
  console.log(`  POST /v1/chat/completions  - OpenAI compatible format (translated)`);
  console.log(`  GET  /health               - Health check`);
  console.log(`  GET  /dashboard/accounts   - Manage Claude accounts`);

  if (!config.apiKey) {
    const CHECK_INTERVAL = 30 * 60 * 1000;
    scheduledTokenRefresh().catch((e) => console.error("[cron] initial refresh:", e.message));
    setInterval(() => scheduledTokenRefresh().catch((e) => console.error("[cron]", e.message)), CHECK_INTERVAL);
    console.log(`  Token auto-refresh: checking all accounts every 30 minutes`);
  }
});
