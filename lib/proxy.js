import Anthropic from "@anthropic-ai/sdk";
import { openaiToClaude, claudeToOpenai, claudeStreamChunkToOpenai, createStreamState } from "./translate.js";
import {
  pickActiveAccount,
  countAccounts,
  listAccounts,
  markAccountUnavailable,
  markAccountError,
  clearAccountError,
} from "./accountsStore.js";
import { ensureFreshAccount } from "./claudeOAuth.js";
import { insertRequestLog } from "./db.js";
import { computeSessionKey } from "./sessionKey.js";
import { getRoute, setRoute, deleteRoute } from "./sessionRoutes.js";
import { inspectRequest } from "./requestInspector.js";
import { cacheClaudeHeaders, getCachedClaudeHeaders } from "./headerCache.js";
import { getOrAssignUserPin } from "./users.js";
import {
  applyCloaking,
  cloakTools,
  decloakResponseToolNames,
  decloakStreamEvent,
  mergeOauthRequiredBetas,
  CLAUDE_VERSION,
} from "./cloaking.js";

function parseRetryAfter(err) {
  // Anthropic SDK surfaces upstream headers via err.headers; check common shapes.
  const h = err?.headers || err?.response?.headers || null;
  const raw = h
    ? (typeof h.get === "function" ? h.get("retry-after") : h["retry-after"])
    : null;
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) return Date.now() + seconds * 1000;
    // RFC 7231 also permits HTTP-date — try parsing
    const ts = Date.parse(raw);
    if (!Number.isNaN(ts) && ts > Date.now()) return ts;
  }
  // Some Anthropic errors include retry_after in the body
  const bodyRetry = err?.error?.error?.retry_after || err?.error?.retry_after;
  if (bodyRetry && Number.isFinite(Number(bodyRetry))) {
    return Date.now() + Number(bodyRetry) * 1000;
  }
  return null;
}

function prepareBody(body, token) {
  if (!body.system) {
    body.system = [{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }];
  } else if (typeof body.system === "string") {
    body.system = [{ type: "text", text: body.system }];
  }
  return applyCloaking(body, token);
}

function buildClaudeIdentityHeaders() {
  const cached = getCachedClaudeHeaders();
  let headers;
  if (cached) {
    // Replay the captured headers verbatim. Anthropic's SDK sets a few of its
    // own (Authorization, anthropic-version) so we only override what we have.
    headers = {};
    for (const [k, v] of Object.entries(cached)) {
      // Convert lowercase header keys back to Title-Case style the SDK uses
      // for defaultHeaders. The SDK lowercases on send, so casing is cosmetic.
      headers[k.split("-").map((s) => s[0].toUpperCase() + s.slice(1)).join("-")] = v;
    }
  } else {
    // Cold-start fallback: use the captured-once-from-real-CC defaults
    headers = {
      "Anthropic-Beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05",
      "Anthropic-Dangerous-Direct-Browser-Access": "true",
      "User-Agent": `claude-cli/${CLAUDE_VERSION} (external, cli)`,
      "X-App": "cli",
    };
  }
  // Upstream clients talking to this proxy are typically in API-key mode and
  // emit an Anthropic-Beta that lacks oauth-2025-04-20. Replaying that to
  // Anthropic with a Bearer OAuth token triggers "OAuth authentication is
  // currently not supported." Force-merge the required OAuth flags here.
  headers["Anthropic-Beta"] = mergeOauthRequiredBetas(headers["Anthropic-Beta"]);
  return headers;
}

function createClient(config, accessToken) {
  return new Anthropic({
    baseURL: config.baseUrl,
    authToken: accessToken,
    defaultHeaders: buildClaudeIdentityHeaders(),
  });
}

function createApiKeyClient(config) {
  // API-key path doesn't need OAuth-only beta flags; keep static minimum.
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

/**
 * Run an attempt against a Claude account, with sticky routing + fallback.
 *
 * @param {object} config
 * @param {http.ServerResponse} clientRes
 * @param {(args: { client: Anthropic, account: object | null }) => Promise<any>} attempt
 * @param {object} ctx — populated by caller (sessionKey, model). model may
 *   be set inside attempt — see prepareBody flow.
 */
async function runWithFailover(config, clientRes, attempt, ctx) {
  if (config.apiKey) {
    return attempt({ client: createApiKeyClient(config), account: null });
  }

  if ((await countAccounts()) === 0) {
    throw new Error("No Claude accounts configured. Add one from /dashboard/accounts.");
  }

  // Per-user pin: compute once before the loop using the current account list.
  // Falls back to null if the user has no row or no candidates exist.
  let userPinId = null;
  if (ctx.userEmail) {
    const accounts = await listAccounts();
    const activeAccounts = accounts.filter((a) => a.isActive);
    userPinId = getOrAssignUserPin(ctx.userEmail, activeAccounts);
  }

  const sessionPinId = ctx.sessionKey ? getRoute(ctx.sessionKey) : null;
  let preferredAccountId = sessionPinId || userPinId;
  const excludeIds = new Set();
  let lastError = null;

  while (true) {
    const picked = await pickActiveAccount({
      excludeIds,
      model: ctx.model,
      preferredAccountId,
    });

    if (!picked) {
      throw lastError || new Error("No active Claude accounts available");
    }
    if (picked.allLocked) {
      const err = new Error(picked.lastError || "All Claude accounts are rate-limited");
      err.status = picked.lastErrorCode || 503;
      err.retryAfterIso = picked.retryAfter;
      err.retryAfterHuman = picked.retryAfterHuman;
      throw err;
    }

    const account = await ensureFreshAccount(picked);
    ctx.accountId = account.id;
    // If we had a sticky pin but pickActiveAccount chose someone else, the
    // pinned account was deleted or locked — drop the stale route entry so
    // next turn doesn't waste a lookup on it.
    if (preferredAccountId && preferredAccountId !== account.id && ctx.sessionKey) {
      deleteRoute(ctx.sessionKey);
    }
    const userPinLabel = userPinId == null
      ? "n/a"
      : (userPinId === account.id ? "true" : "miss");
    console.log(`[proxy] -> using account ${account.name || account.id} (preferred=${preferredAccountId === account.id}, userPin=${userPinLabel})`);

    try {
      const result = await attempt({ account, client: createClient(config, account.accessToken) });
      if (ctx.sessionKey) setRoute(ctx.sessionKey, account.id);
      await clearAccountError(account.id, ctx.model);
      return result;
    } catch (err) {
      const status = err?.status || err?.response?.status || 500;
      const message = err?.message || "Unknown error";
      const resetsAtMs = parseRetryAfter(err);

      const { shouldFallback } = await markAccountUnavailable(
        account.id, status, message, ctx.model, resetsAtMs
      );

      if (!shouldFallback || clientRes.headersSent) throw err;

      excludeIds.add(account.id);
      preferredAccountId = null; // session/user pin failed; let strategy pick next
      lastError = err;
      console.warn(`[proxy] account ${account.id.slice(0,8)} failed (${status}); falling back`);
    }
  }
}

export async function handleMessages(reqBody, clientRes, config, options = {}) {
  const startTime = Date.now();
  const ctx = {
    accountId: null,
    model: null,
    stream: false,
    inputTokens: null,
    outputTokens: null,
    sessionKey: null,
  };
  const userToken = options.userToken && !options.userToken.bypass ? options.userToken : null;
  const reqHeaders = options.reqHeaders || {};
  inspectRequest(reqHeaders, reqBody);
  cacheClaudeHeaders(reqHeaders);
  ctx.sessionKey = computeSessionKey(reqHeaders, reqBody, userToken?.id);
  ctx.userEmail = userToken?.userEmail || null;
  // Resolve model BEFORE the first pick so model-locked accounts are filtered
  // on the first iteration, not just retries. prepareBody doesn't change the
  // model field, so reading reqBody.model here is equivalent.
  ctx.model = reqBody.model || null;

  let status = 0;
  let errMsg = null;

  try {
    await runWithFailover(config, clientRes, async ({ client, account }) => {
      const token = account?.accessToken || config.apiKey;
      // Cloak tools BEFORE prepareBody so the billing-header `cch` hash covers
      // the on-wire body (decoys included), matching what real Claude Code emits.
      const cloaked = cloakTools({ ...reqBody });
      const prepared = prepareBody(cloaked.body, token);
      const toolNameMap = cloaked.toolNameMap;
      ctx.stream = !!prepared.stream;

      console.log(`[proxy] -> /v1/messages (account: ${account?.id || "api-key"}, stream: ${ctx.stream}, model: ${ctx.model}, sessionKey: ${ctx.sessionKey ? ctx.sessionKey.slice(0,16)+"…" : "none"})`);

      if (prepared.stream) {
        const stream = await client.messages.create({ ...prepared, stream: true });
        clientRes.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        for await (const rawEvent of stream) {
          const event = decloakStreamEvent(rawEvent, toolNameMap);
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
        const rawResponse = await client.messages.create(prepared);
        const response = decloakResponseToolNames(rawResponse, toolNameMap);
        ctx.inputTokens = response.usage?.input_tokens ?? null;
        ctx.outputTokens = response.usage?.output_tokens ?? null;
        clientRes.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        clientRes.end(JSON.stringify(response));
        status = 200;
      }
    }, ctx);
  } catch (err) {
    console.error(`[proxy] error ${err.status || ""}:`, err.message);
    status = err.status || 502;
    errMsg = err.message;
    if (!clientRes.headersSent) {
      const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
      if (err.retryAfterIso) {
        const ms = new Date(err.retryAfterIso).getTime() - Date.now();
        if (Number.isFinite(ms)) {
          headers["Retry-After"] = String(Math.max(1, Math.ceil(ms / 1000)));
        }
      }
      clientRes.writeHead(status, headers);
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
  const ctx = {
    accountId: null,
    model: null,
    stream: false,
    inputTokens: null,
    outputTokens: null,
    sessionKey: null,
  };
  const userToken = options.userToken && !options.userToken.bypass ? options.userToken : null;
  const reqHeaders = options.reqHeaders || {};
  // Translate up front so sessionKey hashes the Claude-native shape, and
  // reuse inside the attempt loop so we don't translate per retry.
  const claudeBody = openaiToClaude(reqBody);
  inspectRequest(reqHeaders, claudeBody);
  cacheClaudeHeaders(reqHeaders);
  ctx.sessionKey = computeSessionKey(reqHeaders, claudeBody, userToken?.id);
  ctx.userEmail = userToken?.userEmail || null;
  ctx.model = claudeBody.model || null;

  let status = 0;
  let errMsg = null;

  try {
    await runWithFailover(config, clientRes, async ({ client, account }) => {
      const token = account?.accessToken || config.apiKey;
      // Cloak tools BEFORE prepareBody so the billing-header `cch` hash covers
      // the on-wire body (decoys included), matching what real Claude Code emits.
      const cloaked = cloakTools({ ...claudeBody });
      const prepared = prepareBody(cloaked.body, token);
      const toolNameMap = cloaked.toolNameMap;
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
        for await (const rawEvent of stream) {
          const event = decloakStreamEvent(rawEvent, toolNameMap);
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
        const rawResponse = await client.messages.create(prepared);
        const response = decloakResponseToolNames(rawResponse, toolNameMap);
        ctx.inputTokens = response.usage?.input_tokens ?? null;
        ctx.outputTokens = response.usage?.output_tokens ?? null;
        const openaiResponse = claudeToOpenai(response);
        clientRes.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        clientRes.end(JSON.stringify(openaiResponse));
        status = 200;
      }
    }, ctx);
  } catch (err) {
    console.error(`[proxy] error ${err.status || ""}:`, err.message);
    status = err.status || 502;
    errMsg = err.message;
    if (!clientRes.headersSent) {
      const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
      if (err.retryAfterIso) {
        const ms = new Date(err.retryAfterIso).getTime() - Date.now();
        if (Number.isFinite(ms)) {
          headers["Retry-After"] = String(Math.max(1, Math.ceil(ms / 1000)));
        }
      }
      clientRes.writeHead(status, headers);
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
