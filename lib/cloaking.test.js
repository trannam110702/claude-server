import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCloaking } from "./cloaking.js";
import { cloakTools, decloakResponseToolNames, decloakStreamEvent, CLAUDE_TOOL_SUFFIX, CC_DECOY_TOOL_NAMES, mergeOauthRequiredBetas, REQUIRED_OAUTH_BETAS } from "./cloaking.js";

const OAUTH = "sk-ant-oat01-fake";
const APIKEY = "sk-ant-api03-fake";

test("applyCloaking returns body untouched when token is not OAuth", () => {
  const body = { model: "claude-sonnet-4-6", messages: [], system: [{ type: "text", text: "hi" }] };
  const out = applyCloaking(body, APIKEY);
  assert.deepEqual(out, body);
});

test("applyCloaking injects billing-header text block at system[0] for OAuth", () => {
  const body = { model: "claude-sonnet-4-6", messages: [], system: [{ type: "text", text: "user system" }] };
  const out = applyCloaking(body, OAUTH);
  assert.equal(out.system.length, 2);
  // cc_entrypoint=sdk-cli matches Claude Code 2.1.92+ (and 9router's reference).
  assert.match(out.system[0].text, /^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.[0-9a-f]+; cc_entrypoint=sdk-cli; cch=[0-9a-f]+;/);
  assert.deepEqual(out.system[1], { type: "text", text: "user system" });
});

test("applyCloaking is idempotent — does not double-inject billing-header", () => {
  const body = { model: "x", messages: [], system: [{ type: "text", text: "u" }] };
  const once = applyCloaking(body, OAUTH);
  const twice = applyCloaking(once, OAUTH);
  assert.equal(twice.system.length, 2);
});

test("applyCloaking promotes string system to array", () => {
  const body = { model: "x", messages: [], system: "plain string" };
  const out = applyCloaking(body, OAUTH);
  assert.equal(Array.isArray(out.system), true);
  assert.equal(out.system.length, 2);
  assert.equal(out.system[1].text, "plain string");
});

test("applyCloaking creates system if absent", () => {
  const body = { model: "x", messages: [] };
  const out = applyCloaking(body, OAUTH);
  assert.equal(out.system.length, 1);
  assert.match(out.system[0].text, /^x-anthropic-billing-header:/);
});

test("applyCloaking injects metadata.user_id as JSON-string fingerprint when missing", () => {
  const body = { model: "x", messages: [] };
  const out = applyCloaking(body, OAUTH);
  // CC 2.1.92+ format: {"device_id":"<64hex>","account_uuid":"<uuid>","session_id":"<uuid>"}
  const parsed = JSON.parse(out.metadata.user_id);
  assert.match(parsed.device_id, /^[0-9a-f]{64}$/);
  assert.match(parsed.account_uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(parsed.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("applyCloaking pins user_id.session_id to caller-provided sessionId", () => {
  // Anthropic uses (X-Claude-Code-Session-Id, metadata.user_id.session_id)
  // as a coherent fingerprint — they must agree.
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const body = { model: "x", messages: [] };
  const out = applyCloaking(body, OAUTH, sessionId);
  const parsed = JSON.parse(out.metadata.user_id);
  assert.equal(parsed.session_id, sessionId);
});

test("applyCloaking preserves existing metadata.user_id", () => {
  const existing = `{"device_id":"${"a".repeat(64)}","account_uuid":"00000000-0000-4000-8000-000000000000","session_id":"00000000-0000-4000-8000-000000000000"}`;
  const body = { model: "x", messages: [], metadata: { user_id: existing } };
  const out = applyCloaking(body, OAUTH);
  assert.equal(out.metadata.user_id, existing);
});

test("cloakTools returns body+null map when tools is absent or empty", () => {
  const r1 = cloakTools({ messages: [] });
  assert.equal(r1.toolNameMap, null);
  assert.deepEqual(r1.body.tools, undefined);
  const r2 = cloakTools({ messages: [], tools: [] });
  assert.equal(r2.toolNameMap, null);
});

test("cloakTools suffixes every client tool name with _ide", () => {
  const body = {
    messages: [],
    tools: [
      { name: "lookup_user", description: "X", input_schema: { type: "object", properties: {} } },
      { name: "send_email", description: "Y", input_schema: { type: "object", properties: {} } },
    ],
  };
  const { body: out, toolNameMap } = cloakTools(body);
  const clientNames = out.tools.slice(0, 2).map(t => t.name);
  assert.deepEqual(clientNames, ["lookup_user_ide", "send_email_ide"]);
  assert.equal(toolNameMap.get("lookup_user_ide"), "lookup_user");
  assert.equal(toolNameMap.get("send_email_ide"), "send_email");
});

test("cloakTools appends Claude Code decoys after client tools", () => {
  const body = {
    messages: [],
    tools: [{ name: "x", description: "", input_schema: { type: "object", properties: {} } }],
  };
  const { body: out } = cloakTools(body);
  // First entry is the client tool (suffixed), rest are decoys
  assert.equal(out.tools[0].name, "x_ide");
  const decoyNames = out.tools.slice(1).map(t => t.name);
  for (const n of CC_DECOY_TOOL_NAMES) assert.ok(decoyNames.includes(n), `missing decoy: ${n}`);
  // Decoys must be marked unavailable
  assert.equal(out.tools[1].description, "This tool is currently unavailable.");
});

test("cloakTools renames tool_use blocks in message history", () => {
  const body = {
    tools: [{ name: "lookup_user", description: "", input_schema: { type: "object", properties: {} } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "tu_1", name: "lookup_user", input: { id: 1 } },
      ]},
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
    ],
  };
  const { body: out } = cloakTools(body);
  assert.equal(out.messages[1].content[1].name, "lookup_user_ide");
  // tool_result blocks reference id, not name — left as-is
  assert.equal(out.messages[2].content[0].tool_use_id, "tu_1");
});

test("cloakTools leaves string-content messages alone", () => {
  const body = {
    tools: [{ name: "x", description: "", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "hello" }],
  };
  const { body: out } = cloakTools(body);
  assert.equal(out.messages[0].content, "hello");
});

test("decloakResponseToolNames strips _ide suffix from response.content[*].name", () => {
  const map = new Map([["lookup_user_ide", "lookup_user"]]);
  const response = {
    content: [
      { type: "text", text: "calling tool" },
      { type: "tool_use", id: "tu_1", name: "lookup_user_ide", input: { id: 1 } },
    ],
  };
  const out = decloakResponseToolNames(response, map);
  assert.equal(out.content[1].name, "lookup_user");
  // text block untouched
  assert.equal(out.content[0].text, "calling tool");
});

test("decloakResponseToolNames is a no-op for empty/null map", () => {
  const response = { content: [{ type: "tool_use", name: "x_ide" }] };
  assert.equal(decloakResponseToolNames(response, null).content[0].name, "x_ide");
  assert.equal(decloakResponseToolNames(response, new Map()).content[0].name, "x_ide");
});

test("decloakStreamEvent rewrites name on content_block_start tool_use events", () => {
  const map = new Map([["lookup_user_ide", "lookup_user"]]);
  const event = {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "tu_1", name: "lookup_user_ide", input: {} },
  };
  const out = decloakStreamEvent(event, map);
  assert.equal(out.content_block.name, "lookup_user");
});

test("decloakStreamEvent passes through non-tool events untouched", () => {
  const map = new Map([["x_ide", "x"]]);
  const event = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } };
  assert.deepEqual(decloakStreamEvent(event, map), event);
});

test("CLAUDE_TOOL_SUFFIX is _ide (matches reference)", () => {
  assert.equal(CLAUDE_TOOL_SUFFIX, "_ide");
});

test("mergeOauthRequiredBetas returns required flags when input is empty/null/undefined", () => {
  // Both required flags must end up in the output, comma-joined.
  for (const empty of [undefined, null, "", "   "]) {
    const out = mergeOauthRequiredBetas(empty);
    for (const flag of REQUIRED_OAUTH_BETAS) {
      assert.ok(out.split(",").map(s => s.trim()).includes(flag), `missing ${flag} in: ${out}`);
    }
  }
});

test("mergeOauthRequiredBetas prepends missing flags without dropping existing", () => {
  // Simulates a cached anthropic-beta from a CC client that talked to the proxy
  // in API-key mode (no oauth-2025-04-20).
  const cachedBeta = "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14";
  const out = mergeOauthRequiredBetas(cachedBeta);
  const flags = out.split(",").map(s => s.trim());
  assert.ok(flags.includes("oauth-2025-04-20"), "must inject oauth-2025-04-20");
  assert.ok(flags.includes("claude-code-20250219"), "must keep claude-code-20250219");
  assert.ok(flags.includes("interleaved-thinking-2025-05-14"), "must keep cached flag");
  assert.ok(flags.includes("fine-grained-tool-streaming-2025-05-14"), "must keep cached flag");
});

test("mergeOauthRequiredBetas is idempotent when all required flags already present", () => {
  const beta = "oauth-2025-04-20,claude-code-20250219,extra-flag";
  const out = mergeOauthRequiredBetas(beta);
  const flags = out.split(",").map(s => s.trim());
  // No duplicates introduced
  for (const flag of REQUIRED_OAUTH_BETAS) {
    assert.equal(flags.filter(f => f === flag).length, 1, `duplicate of ${flag}`);
  }
  assert.ok(flags.includes("extra-flag"));
});

test("mergeOauthRequiredBetas tolerates whitespace around commas", () => {
  const out = mergeOauthRequiredBetas(" claude-code-20250219 ,  some-flag ");
  const flags = out.split(",").map(s => s.trim());
  assert.ok(flags.includes("oauth-2025-04-20"));
  assert.ok(flags.includes("claude-code-20250219"));
  assert.ok(flags.includes("some-flag"));
});

test("REQUIRED_OAUTH_BETAS matches 9router providers.claude.headers Anthropic-Beta", () => {
  // Sentinel: this is the proxy's authoritative list, mirrored from
  // 9router/open-sse/config/providers.js. Cached upstream betas can ADD flags
  // but never REMOVE any of these. Keep exhaustive on purpose.
  assert.deepEqual([...REQUIRED_OAUTH_BETAS].sort(), [
    "advanced-tool-use-2025-11-20",
    "claude-code-20250219",
    "context-management-2025-06-27",
    "effort-2025-11-24",
    "fast-mode-2026-02-01",
    "interleaved-thinking-2025-05-14",
    "oauth-2025-04-20",
    "prompt-caching-scope-2026-01-05",
    "redact-thinking-2026-02-12",
    "structured-outputs-2025-12-15",
    "token-efficient-tools-2026-03-28",
  ]);
});

test("mergeOauthRequiredBetas restores context-management when cache strips it", () => {
  // Regression: a cache populated by CC-via-API-key-mode often lacks
  // context-management-2025-06-27, which Anthropic uses to gate server-side
  // auto-compaction; without it a full prompt is billed as long context and
  // returns 429 "Extra usage is required for long context requests."
  const cachedBeta = "claude-code-20250219,fine-grained-tool-streaming-2025-05-14";
  const out = mergeOauthRequiredBetas(cachedBeta);
  const flags = out.split(",").map(s => s.trim());
  assert.ok(flags.includes("context-management-2025-06-27"), "must inject context-management-2025-06-27");
  assert.ok(flags.includes("oauth-2025-04-20"), "must inject oauth-2025-04-20");
});

test("mergeOauthRequiredBetas preserves cached flags the proxy doesn't know about", () => {
  // Forward-compat: if upstream CC ever adds a new beta we don't list, we
  // shouldn't drop it on the floor.
  const cachedBeta = "claude-code-20250219,future-feature-2027-01-01";
  const out = mergeOauthRequiredBetas(cachedBeta);
  const flags = out.split(",").map(s => s.trim());
  assert.ok(flags.includes("future-feature-2027-01-01"));
});
