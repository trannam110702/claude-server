import crypto from "node:crypto";

export const CLAUDE_VERSION = "2.1.63";
const BILLING_PREFIX = "x-anthropic-billing-header:";

// Beta flags Anthropic requires when authenticating with an OAuth Bearer token
// on /v1/messages. Without `oauth-2025-04-20` the API rejects with 401
// "OAuth authentication is currently not supported." `claude-code-20250219`
// gates Claude-Code-only model surface area. These must always be set on the
// OAuth path regardless of what an upstream client sent — upstream clients
// talking to this proxy are typically in API-key mode and won't include them.
export const REQUIRED_OAUTH_BETAS = Object.freeze(["oauth-2025-04-20", "claude-code-20250219"]);

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
  return `${BILLING_PREFIX} cc_version=${CLAUDE_VERSION}.${buildHash}; cc_entrypoint=cli; cch=${cch};`;
}

function generateUUID() {
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function applyCloaking(body, token) {
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
    result.metadata = { ...result.metadata, user_id: generateUUID() };
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
