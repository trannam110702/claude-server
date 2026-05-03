import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSessionKey, firstMessageHash } from "./sessionKey.js";

const baseBody = { messages: [{ role: "user", content: "hello" }] };

test("computeSessionKey returns null without userTokenId", () => {
  assert.equal(computeSessionKey({}, baseBody, null), null);
  assert.equal(computeSessionKey({}, baseBody, ""), null);
});

test("computeSessionKey prefers x-claude-session-id header", () => {
  const k = computeSessionKey(
    { "x-claude-session-id": "sess-A", "anthropic-conversation-id": "conv-B" },
    { metadata: { user_id: "U" }, ...baseBody },
    "tok-1"
  );
  assert.equal(k, "tok-1:sess-A");
});

test("computeSessionKey prefers anthropic-conversation-id over metadata", () => {
  const k = computeSessionKey(
    { "anthropic-conversation-id": "conv-B" },
    { metadata: { user_id: "U" }, ...baseBody },
    "tok-1"
  );
  assert.equal(k, "tok-1:conv-B");
});

test("computeSessionKey prefers metadata.session_id over user_id", () => {
  const k = computeSessionKey(
    {},
    { metadata: { session_id: "S", user_id: "U" }, ...baseBody },
    "tok-1"
  );
  assert.equal(k, "tok-1:S");
});

test("computeSessionKey uses metadata.user_id when no session candidates", () => {
  const k = computeSessionKey(
    {},
    { metadata: { user_id: "U" }, ...baseBody },
    "tok-1"
  );
  assert.equal(k, "tok-1:U");
});

test("computeSessionKey falls back to firstMessageHash", () => {
  const k = computeSessionKey({}, baseBody, "tok-1");
  const h = firstMessageHash(baseBody);
  assert.equal(k, `tok-1:${h}`);
  assert.match(h, /^[0-9a-f]{16}$/);
});

test("computeSessionKey returns null when no candidates and no messages", () => {
  assert.equal(computeSessionKey({}, {}, "tok-1"), null);
  assert.equal(computeSessionKey({}, { messages: [] }, "tok-1"), null);
});

test("firstMessageHash is stable for the same first message", () => {
  const a = firstMessageHash({ messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }] });
  const b = firstMessageHash({ messages: [{ role: "user", content: "x" }] });
  assert.equal(a, b);
});

test("firstMessageHash differs for different first messages", () => {
  const a = firstMessageHash({ messages: [{ role: "user", content: "hello" }] });
  const b = firstMessageHash({ messages: [{ role: "user", content: "hi" }] });
  assert.notEqual(a, b);
});
