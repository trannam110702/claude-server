import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import { openaiToClaude, claudeToOpenai, claudeStreamChunkToOpenai, createStreamState } from "./translate.js";
import {
  pickActiveAccount,
  markAccountUsed,
  markAccountError,
  countAccounts,
  listAccounts,
} from "./accountsStore.js";
import { ensureFreshAccount } from "./claudeOAuth.js";
import { insertRequestLog } from "./db.js";

const CLAUDE_VERSION = "2.1.63";

function generateBillingHeader(payload) {
  const content = JSON.stringify(payload);
  const cch = crypto.createHash("sha256").update(content).digest("hex").slice(0, 5);
  const buildHash = crypto.randomBytes(2).toString("hex").slice(0, 3);
  return `x-anthropic-billing-header: cc_version=${CLAUDE_VERSION}.${buildHash}; cc_entrypoint=cli; cch=${cch};`;
}

function generateUUID() {
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function applyCloaking(body, token) {
  if (!token || !token.includes("sk-ant-oat")) return body;

  const result = { ...body };
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

  if (!result.metadata?.user_id) {
    result.metadata = { ...result.metadata, user_id: generateUUID() };
  }
  return result;
}

function prepareBody(body, token) {
  if (!body.system) {
    body.system = [{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }];
  } else if (typeof body.system === "string") {
    body.system = [{ type: "text", text: body.system }];
  }
  return applyCloaking(body, token);
}

function createClient(config, accessToken) {
  return new Anthropic({
    baseURL: config.baseUrl,
    authToken: accessToken,
    defaultHeaders: {
      "Anthropic-Beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05",
      "Anthropic-Dangerous-Direct-Browser-Access": "true",
      "User-Agent": `claude-cli/${CLAUDE_VERSION} (external, cli)`,
      "X-App": "cli",
    },
  });
}

function createApiKeyClient(config) {
  return new Anthropic({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    defaultHeaders: {
      "Anthropic-Beta": "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05",
      "User-Agent": `claude-cli/${CLAUDE_VERSION} (external, cli)`,
      "X-App": "cli",
    },
  });
}

/**
 * Acquire a fresh Claude account for a request.
 * Round-robin: least-recently-used active account is chosen, then its
 * `last_used_at` is bumped so the next request prefers another account.
 *
 * Returns { client, account } or throws if no usable account is available.
 */
async function acquireAccount(config, excludeIds = []) {
  let account = await pickActiveAccount(excludeIds);
  if (!account) return null;

  account = await ensureFreshAccount(account);
  await markAccountUsed(account.id);
  return { account, client: createClient(config, account.accessToken) };
}

// ──────────────────────────────────────────────────────────────────
// Scheduled refresh — keep all accounts warm
// ──────────────────────────────────────────────────────────────────

export async function scheduledTokenRefresh() {
  const accounts = (await listAccounts()).filter(a => a.isActive && a.refreshToken);
  if (!accounts.length) {
    console.log("[cron] no active accounts with refresh tokens");
    return;
  }
  for (const account of accounts) {
    try {
      await ensureFreshAccount(account);
    } catch (err) {
      await markAccountError(account.id, err.message);
      console.error(`[cron] refresh failed for ${account.id}: ${err.message}`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────
// Request handlers
// ──────────────────────────────────────────────────────────────────

async function runWithFailover(config, clientRes, attempt) {
  if (config.apiKey) {
    return attempt({ client: createApiKeyClient(config), account: null });
  }

  if ((await countAccounts()) === 0) {
    throw new Error("No Claude accounts configured. Add one from /dashboard/accounts.");
  }

  const tried = [];
  let lastError = null;
  while (true) {
    const acquired = await acquireAccount(config, tried).catch((e) => {
      lastError = e;
      return null;
    });
    if (!acquired) {
      throw lastError || new Error("No active Claude accounts available");
    }
    try {
      return await attempt(acquired);
    } catch (err) {
      const isAuthError = err?.status === 401 || err?.status === 403;
      const isRateLimit = err?.status === 429;
      // Only retry while we still own the response — once headers are sent
      // (i.e. streaming has started), the client is locked to this account.
      const canRetry = !clientRes.headersSent;
      if ((isAuthError || isRateLimit) && canRetry) {
        await markAccountError(acquired.account.id, `${err.status}: ${err.message}`);
        tried.push(acquired.account.id);
        lastError = err;
        continue;
      }
      throw err;
    }
  }
}

export async function handleMessages(reqBody, clientRes, config, options = {}) {
  const startTime = Date.now();
  const ctx = { accountId: null, model: null, stream: false, inputTokens: null, outputTokens: null };
  const userToken = options.userToken && !options.userToken.bypass ? options.userToken : null;
  let status = 0;
  let errMsg = null;

  try {
    await runWithFailover(config, clientRes, async ({ client, account }) => {
      ctx.accountId = account?.id || null;
      const token = account?.accessToken || config.apiKey;
      const prepared = prepareBody({ ...reqBody }, token);
      ctx.model = prepared.model || null;
      ctx.stream = !!prepared.stream;

      console.log(`[proxy] -> /v1/messages (account: ${account?.id || "api-key"}, stream: ${ctx.stream}, model: ${ctx.model})`);

      if (prepared.stream) {
        const stream = await client.messages.create({ ...prepared, stream: true });
        clientRes.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        for await (const event of stream) {
          if (event.type === "message_start" && event.message?.usage) {
            ctx.inputTokens = event.message.usage.input_tokens ?? ctx.inputTokens;
          }
          if (event.type === "message_delta" && event.usage) {
            ctx.outputTokens = event.usage.output_tokens ?? ctx.outputTokens;
          }
          clientRes.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        clientRes.end();
        status = 200;
      } else {
        const response = await client.messages.create(prepared);
        ctx.inputTokens = response.usage?.input_tokens ?? null;
        ctx.outputTokens = response.usage?.output_tokens ?? null;
        clientRes.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        clientRes.end(JSON.stringify(response));
        status = 200;
      }
    });
  } catch (err) {
    console.error(`[proxy] error ${err.status || ""}:`, err.message);
    status = err.status || 502;
    errMsg = err.message;
    if (!clientRes.headersSent) {
      clientRes.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    }
    clientRes.end(JSON.stringify(err.error || { type: "error", error: { type: "proxy_error", message: err.message } }));
  } finally {
    try {
      const tokens_used =
        (ctx.inputTokens || 0) + (ctx.outputTokens || 0) || null;
      insertRequestLog({
        timestamp: new Date(startTime).toISOString(),
        method: "POST",
        path: "/v1/messages",
        status,
        latency_ms: Date.now() - startTime,
        model: ctx.model,
        account_id: ctx.accountId,
        input_tokens: ctx.inputTokens,
        output_tokens: ctx.outputTokens,
        tokens_used,
        stream: ctx.stream ? 1 : 0,
        error: errMsg,
        user_token_id: userToken?.id || null,
        user_email: userToken?.userEmail || null,
      });
    } catch (e) {
      console.error("[logging] failed:", e.message);
    }
  }
}

export async function handleChatCompletions(reqBody, clientRes, config, options = {}) {
  const startTime = Date.now();
  const ctx = { accountId: null, model: null, stream: false, inputTokens: null, outputTokens: null };
  const userToken = options.userToken && !options.userToken.bypass ? options.userToken : null;
  let status = 0;
  let errMsg = null;

  try {
    await runWithFailover(config, clientRes, async ({ client, account }) => {
      ctx.accountId = account?.id || null;
      const token = account?.accessToken || config.apiKey;
      const claudeBody = openaiToClaude(reqBody);
      const prepared = prepareBody({ ...claudeBody }, token);
      ctx.model = prepared.model || null;
      ctx.stream = !!prepared.stream;

      console.log(`[proxy] -> /v1/chat/completions (account: ${account?.id || "api-key"}, stream: ${ctx.stream}, model: ${ctx.model})`);

      if (prepared.stream) {
        const state = createStreamState();
        const stream = await client.messages.create({ ...prepared, stream: true });
        clientRes.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        for await (const event of stream) {
          if (event.type === "message_start" && event.message?.usage) {
            ctx.inputTokens = event.message.usage.input_tokens ?? ctx.inputTokens;
          }
          if (event.type === "message_delta" && event.usage) {
            ctx.outputTokens = event.usage.output_tokens ?? ctx.outputTokens;
          }
          const openaiChunks = claudeStreamChunkToOpenai(event, state);
          if (openaiChunks) {
            for (const chunk of openaiChunks) {
              clientRes.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
          }
        }
        clientRes.end();
        status = 200;
      } else {
        const response = await client.messages.create(prepared);
        ctx.inputTokens = response.usage?.input_tokens ?? null;
        ctx.outputTokens = response.usage?.output_tokens ?? null;
        const openaiResponse = claudeToOpenai(response);
        clientRes.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        clientRes.end(JSON.stringify(openaiResponse));
        status = 200;
      }
    });
  } catch (err) {
    console.error(`[proxy] error ${err.status || ""}:`, err.message);
    status = err.status || 502;
    errMsg = err.message;
    if (!clientRes.headersSent) {
      clientRes.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    }
    clientRes.end(JSON.stringify({ error: { message: err.message, type: "api_error", code: status } }));
  } finally {
    try {
      const tokens_used =
        (ctx.inputTokens || 0) + (ctx.outputTokens || 0) || null;
      insertRequestLog({
        timestamp: new Date(startTime).toISOString(),
        method: "POST",
        path: "/v1/chat/completions",
        status,
        latency_ms: Date.now() - startTime,
        model: ctx.model,
        account_id: ctx.accountId,
        input_tokens: ctx.inputTokens,
        output_tokens: ctx.outputTokens,
        tokens_used,
        stream: ctx.stream ? 1 : 0,
        error: errMsg,
        user_token_id: userToken?.id || null,
        user_email: userToken?.userEmail || null,
      });
    } catch (e) {
      console.error("[logging] failed:", e.message);
    }
  }
}
