import crypto from "node:crypto";

// Mirrors 9router's claudeCloaking.js identity (the upstream this codebase was
// adapted from). Bumping CLAUDE_VERSION / CC_ENTRYPOINT / user_id format
// without aligning to a real Claude Code release will diverge our cloaking
// from what Anthropic categorizes as "first-party CC traffic" and trip
// silent billing or anti-abuse rules.
export const CLAUDE_VERSION = "2.1.92";
export const CC_ENTRYPOINT = "sdk-cli";
const BILLING_PREFIX = "x-anthropic-billing-header:";

// Baseline beta flags the proxy guarantees on every OAuth-path call. Upstream
// clients hitting this proxy are typically in API-key mode and emit a partial
// (or absent) anthropic-beta — replaying that verbatim breaks Anthropic in
// hard-to-debug ways:
//   - missing `oauth-2025-04-20` → 401 "OAuth authentication is currently not
//     supported."
//   - missing `context-management-2025-06-27` → 429 "Extra usage is required
//     for long context requests." (server-side auto-compaction is gated by
//     this flag; without it a full prompt trips the long-context billing tier).
// Source-of-truth: 9router/open-sse/config/providers.js → providers.claude.headers.
// Order mirrors that list; anything cached but not in this list is preserved
// verbatim after the baseline.
export const REQUIRED_OAUTH_BETAS = Object.freeze([
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
  "structured-outputs-2025-12-15",
  "fast-mode-2026-02-01",
  "redact-thinking-2026-02-12",
  "token-efficient-tools-2026-03-28",
]);

export function mergeOauthRequiredBetas(betaValue) {
  const existing = (betaValue || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set(existing);
  const missing = REQUIRED_OAUTH_BETAS.filter((b) => !seen.has(b));
  if (missing.length === 0) return existing.join(",");
  return [...missing, ...existing].join(",");
}

function generateBillingHeader(payload) {
  const content = JSON.stringify(payload);
  const cch = crypto.createHash("sha256").update(content).digest("hex").slice(0, 5);
  const buildHash = crypto.randomBytes(2).toString("hex").slice(0, 3);
  return `${BILLING_PREFIX} cc_version=${CLAUDE_VERSION}.${buildHash}; cc_entrypoint=${CC_ENTRYPOINT}; cch=${cch};`;
}

// Real Claude Code 2.1.92+ sends metadata.user_id as a stringified JSON object
// containing device, account, and session identifiers — not a bare UUID. Anthropic
// uses this fingerprint to gate long-context billing and anti-abuse decisions
// (see 9router/open-sse/utils/claudeCloaking.js generateFakeUserID).
export function generateFakeUserID(sessionId) {
  const deviceId = crypto.randomBytes(32).toString("hex");
  const accountUuid = crypto.randomUUID();
  const sessionUuid = sessionId || crypto.randomUUID();
  return `{"device_id":"${deviceId}","account_uuid":"${accountUuid}","session_id":"${sessionUuid}"}`;
}

export function applyCloaking(body, token, sessionId) {
  if (!token || !token.includes("sk-ant-oat")) return body;

  const result = { ...body };
  const billingBlock = { type: "text", text: generateBillingHeader(body) };
  if (Array.isArray(result.system)) {
    if (!result.system[0]?.text?.startsWith(BILLING_PREFIX)) {
      result.system = [billingBlock, ...result.system];
    }
  } else if (typeof result.system === "string") {
    result.system = [billingBlock, { type: "text", text: result.system }];
  } else {
    result.system = [billingBlock];
  }

  if (!result.metadata?.user_id) {
    result.metadata = { ...result.metadata, user_id: generateFakeUserID(sessionId) };
  }
  return result;
}

export const CLAUDE_TOOL_SUFFIX = "_ide";

// Claude Code's native tool names — kept as decoys so Anthropic sees the
// canonical CC tool surface even when the real client is something else.
export const CC_DECOY_TOOL_NAMES = [
  "Task", "TaskOutput", "TaskStop", "TaskCreate", "TaskGet", "TaskUpdate", "TaskList",
  "Bash", "Glob", "Grep", "Read", "Edit", "Write", "NotebookEdit",
  "WebFetch", "WebSearch", "AskUserQuestion", "Skill",
  "EnterPlanMode", "ExitPlanMode",
];

const CC_DECOY_TOOLS = CC_DECOY_TOOL_NAMES.map((name) => ({
  name,
  description: "This tool is currently unavailable.",
  input_schema: { type: "object", properties: {} },
}));

export function cloakTools(body) {
  const tools = body?.tools;
  if (!tools || tools.length === 0) return { body, toolNameMap: null };

  const toolNameMap = new Map();
  const clientDeclarations = [];
  for (const tool of tools) {
    const suffixed = `${tool.name}${CLAUDE_TOOL_SUFFIX}`;
    toolNameMap.set(suffixed, tool.name);
    clientDeclarations.push({ ...tool, name: suffixed });
  }
  const allTools = [...clientDeclarations, ...CC_DECOY_TOOLS];

  const renamedMessages = body.messages?.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    const renamedContent = msg.content.map((block) => {
      if (block?.type === "tool_use" && toolNameMap.has(`${block.name}${CLAUDE_TOOL_SUFFIX}`)) {
        return { ...block, name: `${block.name}${CLAUDE_TOOL_SUFFIX}` };
      }
      return block;
    });
    return { ...msg, content: renamedContent };
  });

  return {
    body: { ...body, tools: allTools, messages: renamedMessages || body.messages },
    toolNameMap,
  };
}

export function decloakResponseToolNames(response, toolNameMap) {
  if (!toolNameMap?.size || !Array.isArray(response?.content)) return response;
  const content = response.content.map((block) => {
    if (block?.type === "tool_use" && toolNameMap.has(block.name)) {
      return { ...block, name: toolNameMap.get(block.name) };
    }
    return block;
  });
  return { ...response, content };
}

export function decloakStreamEvent(event, toolNameMap) {
  if (!toolNameMap?.size) return event;
  if (event?.type !== "content_block_start") return event;
  const cb = event.content_block;
  if (cb?.type !== "tool_use" || !toolNameMap.has(cb.name)) return event;
  return { ...event, content_block: { ...cb, name: toolNameMap.get(cb.name) } };
}
