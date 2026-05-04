import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCloaking } from "./cloaking.js";
import { cloakTools, decloakResponseToolNames, decloakStreamEvent, CLAUDE_TOOL_SUFFIX, CC_DECOY_TOOL_NAMES } from "./cloaking.js";

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
  assert.match(out.system[0].text, /^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.[0-9a-f]+; cc_entrypoint=cli; cch=[0-9a-f]+;/);
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

test("applyCloaking injects metadata.user_id (UUID) when missing", () => {
  const body = { model: "x", messages: [] };
  const out = applyCloaking(body, OAUTH);
  assert.match(out.metadata.user_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("applyCloaking preserves existing metadata.user_id", () => {
  const existing = "00000000-0000-4000-8000-000000000000";
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
