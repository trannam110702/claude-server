import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCloaking } from "./cloaking.js";

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
