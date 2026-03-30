import http from "node:http";
import { handleMessages, handleChatCompletions, scheduledTokenRefresh } from "./lib/proxy.js";
import { readTokens } from "./lib/login.js";

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

// Config — tokens.json takes priority, env vars as fallback (for Docker)
const tokens = readTokens();

const config = {
  port: parseInt(process.env.PORT || "8080"),
  host: process.env.HOST || "127.0.0.1",
  baseUrl: (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, ""),
  apiKey: process.env.ANTHROPIC_API_KEY || null,
  accessToken: tokens?.accessToken || process.env.OAUTH_ACCESS_TOKEN || null,
  refreshToken: tokens?.refreshToken || process.env.OAUTH_REFRESH_TOKEN || null,
  clientId: tokens?.clientId || "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  tokenExpiresAt: tokens?.expiresAt ? new Date(tokens.expiresAt).getTime() : null,
};

if (!config.apiKey && !config.accessToken && !config.refreshToken) {
  console.error("No credentials found. Run 'npm run login' to authenticate with Claude.");
  process.exit(1);
}

// Read request body helper
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

// CORS preflight handler
function handleCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

// Server
const server = http.createServer(async (req, res) => {
  if (handleCors(req, res)) return;

  // Normalize path: remove trailing slash, handle double /v1/v1/
  let path = req.url.split("?")[0].replace(/\/+$/, "").replace(/\/v1\/v1\//, "/v1/");

  // Log request
  console.log(`[${new Date().toISOString()}] ${req.method} ${path}`);

  try {
    // Health check
    if (path === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ status: "ok", auth: config.apiKey ? "api_key" : "oauth" }));
      return;
    }

    // Claude native format - pass through
    if (path === "/v1/messages" && req.method === "POST") {
      const body = await readBody(req);
      await handleMessages(body, res, config);
      return;
    }

    // OpenAI compatible format - translate
    if (path === "/v1/chat/completions" && req.method === "POST") {
      const body = await readBody(req);
      await handleChatCompletions(body, res, config);
      return;
    }

    // 404
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
  console.log(`Auth method: ${config.apiKey ? "API key" : "OAuth token"}`);
  console.log(`Endpoints:`);
  console.log(`  POST /v1/messages          - Claude native format (pass-through)`);
  console.log(`  POST /v1/chat/completions  - OpenAI compatible format (translated)`);
  console.log(`  GET  /health               - Health check`);

  // Check token expiry every 30 minutes, refresh if within 5 hours of expiring
  if (config.refreshToken) {
    const CHECK_INTERVAL = 30 * 60 * 1000;
    scheduledTokenRefresh(config);
    setInterval(() => scheduledTokenRefresh(config), CHECK_INTERVAL);
    console.log(`  Token auto-refresh: checking every 30 minutes`);
  }
});
