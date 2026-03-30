import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import https from "node:https";
import { openaiToClaude, claudeToOpenai, claudeStreamChunkToOpenai, createStreamState } from "./translate.js";
import { saveTokens } from "./login.js";

const CLAUDE_VERSION = "2.1.63";

// Generate billing header matching real Claude Code format
function generateBillingHeader(payload) {
  const content = JSON.stringify(payload);
  const cch = crypto.createHash("sha256").update(content).digest("hex").slice(0, 5);
  const buildHash = crypto.randomBytes(2).toString("hex").slice(0, 3);
  return `x-anthropic-billing-header: cc_version=${CLAUDE_VERSION}.${buildHash}; cc_entrypoint=cli; cch=${cch};`;
}

// Generate a random UUID v4
function generateUUID() {
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

// Apply OAuth cloaking: billing header + fake user ID
function applyCloaking(body, token) {
  if (!token || !token.includes("sk-ant-oat")) return body;

  const result = { ...body };

  // Inject billing header as system[0]
  const billingBlock = { type: "text", text: generateBillingHeader(body) };
  if (Array.isArray(result.system)) {
    if (!result.system[0]?.text?.startsWith("x-anthropic-billing-header:")) {
      result.system = [billingBlock, ...result.system];
    }
  } else if (typeof result.system === "string") {
    result.system = [billingBlock, { type: "text", text: result.system }];
  } else {
    result.system = [billingBlock];
  }

  // Inject fake user ID
  if (!result.metadata?.user_id) {
    result.metadata = { ...result.metadata, user_id: generateUUID() };
  }

  return result;
}

// Prepare request body for Claude API
function prepareBody(body, config) {
  if (!body.system) {
    body.system = [{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }];
  } else if (typeof body.system === "string") {
    body.system = [{ type: "text", text: body.system }];
  }

  // Add cache_control to last system block
  if (Array.isArray(body.system) && body.system.length > 0) {
    body.system[body.system.length - 1].cache_control = { type: "ephemeral", ttl: "1h" };
  }

  const token = config.accessToken || config.apiKey;
  return applyCloaking(body, token);
}

// Refresh OAuth token
async function refreshOAuthToken(config) {
  if (!config.refreshToken) return false;

  const body = JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: config.refreshToken,
    client_id: config.clientId || "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: new URL(config.baseUrl).hostname,
      path: "/v1/oauth/token",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode !== 200) {
          console.error(`[oauth] refresh failed: ${res.statusCode} ${data}`);
          console.error("[oauth] refresh token may be expired. Run 'node index.js login' to re-authenticate.");
          return resolve(false);
        }
        try {
          const tokens = JSON.parse(data);
          config.accessToken = tokens.access_token;
          if (tokens.refresh_token) config.refreshToken = tokens.refresh_token;
          if (tokens.expires_in) {
            config.tokenExpiresAt = Date.now() + tokens.expires_in * 1000;
          }

          // Persist refreshed tokens to tokens.json
          const tokenUpdates = { accessToken: config.accessToken };
          if (tokens.refresh_token) tokenUpdates.refreshToken = config.refreshToken;
          if (tokens.expires_in) {
            tokenUpdates.expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
          }
          saveTokens(tokenUpdates);

          console.log("[oauth] token refreshed and saved to tokens.json");
          resolve(true);
        } catch (e) {
          console.error("[oauth] failed to parse refresh response:", e.message);
          resolve(false);
        }
      });
    });
    req.on("error", (e) => {
      console.error("[oauth] refresh request error:", e.message);
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

// Check if token needs refresh (5 min buffer)
async function ensureValidToken(config) {
  if (!config.accessToken || !config.tokenExpiresAt) return;
  if (config.tokenExpiresAt - Date.now() < 5 * 60 * 1000) {
    console.log("[oauth] token expiring soon, refreshing...");
    await refreshOAuthToken(config);
  }
}

// Create Anthropic client from config
function createClient(config) {
  const opts = {
    baseURL: config.baseUrl,
    defaultHeaders: {
      "Anthropic-Beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05",
      "Anthropic-Dangerous-Direct-Browser-Access": "true",
      "User-Agent": `claude-cli/${CLAUDE_VERSION} (external, cli)`,
      "X-App": "cli"
    }
  };

  if (config.apiKey) {
    opts.apiKey = config.apiKey;
  } else if (config.accessToken) {
    opts.authToken = config.accessToken;
  }

  return new Anthropic(opts);
}

// Handle /v1/messages - pass through to Claude API
export async function handleMessages(reqBody, clientRes, config, retried = false) {
  await ensureValidToken(config);

  const prepared = prepareBody({ ...reqBody }, config);
  const client = createClient(config);

  console.log(`[proxy] -> /v1/messages (auth: ${config.apiKey ? "api-key" : "oauth"}, stream: ${!!prepared.stream}, model: ${prepared.model})`);

  try {
    if (prepared.stream) {
      const stream = await client.messages.create({ ...prepared, stream: true });

      clientRes.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*"
      });

      for await (const event of stream) {
        console.log(`[stream] ${event.type}:`, JSON.stringify(event).slice(0, 200));
        clientRes.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }

      clientRes.end();
    } else {
      const response = await client.messages.create(prepared);
      clientRes.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      clientRes.end(JSON.stringify(response));
    }
  } catch (err) {
    if (err.status === 401 && !retried && config.refreshToken) {
      console.log("[proxy] got 401, attempting token refresh...");
      if (await refreshOAuthToken(config)) {
        return handleMessages(reqBody, clientRes, config, true);
      }
    }
    console.error(`[proxy] error ${err.status || ""}:`, err.message);
    const status = err.status || 502;
    if (!clientRes.headersSent) {
      clientRes.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    }
    clientRes.end(JSON.stringify(err.error || { type: "error", error: { type: "proxy_error", message: err.message } }));
  }
}

// Handle /v1/chat/completions - translate OpenAI -> Claude, forward, translate response back
export async function handleChatCompletions(reqBody, clientRes, config, retried = false) {
  await ensureValidToken(config);

  const claudeBody = openaiToClaude(reqBody);
  const prepared = prepareBody({ ...claudeBody }, config);
  const client = createClient(config);

  console.log(`[proxy] -> /v1/chat/completions (auth: ${config.apiKey ? "api-key" : "oauth"}, stream: ${!!prepared.stream}, model: ${prepared.model})`);
  console.log(`[proxy] request body:`, JSON.stringify(prepared).slice(0, 500));

  try {
    if (prepared.stream) {
      const state = createStreamState();
      const stream = await client.messages.create({ ...prepared, stream: true });

      clientRes.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*"
      });

      for await (const event of stream) {
        console.log(`[stream] ${event.type}:`, JSON.stringify(event).slice(0, 200));
        const openaiChunks = claudeStreamChunkToOpenai(event, state);
        if (openaiChunks) {
          for (const chunk of openaiChunks) {
            clientRes.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
        }
      }

      clientRes.end();
    } else {
      const response = await client.messages.create(prepared);
      const openaiResponse = claudeToOpenai(response);
      clientRes.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      clientRes.end(JSON.stringify(openaiResponse));
    }
  } catch (err) {
    if (err.status === 401 && !retried && config.refreshToken) {
      console.log("[proxy] got 401, attempting token refresh...");
      if (await refreshOAuthToken(config)) {
        return handleChatCompletions(reqBody, clientRes, config, true);
      }
    }
    console.error(`[proxy] error ${err.status || ""}:`, err.message);
    const status = err.status || 502;
    if (!clientRes.headersSent) {
      clientRes.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    }
    clientRes.end(JSON.stringify({ error: { message: err.message, type: "api_error", code: status } }));
  }
}
