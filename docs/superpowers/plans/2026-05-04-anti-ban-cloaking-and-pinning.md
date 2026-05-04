# Anti-Ban: Tool Cloaking, Header Replay, Per-User Pinning

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the chance of Anthropic banning the upstream Claude.ai OAuth accounts by (a) making forwarded requests indistinguishable from real Claude Code, (b) pinning each user to a single account so blast radius is bounded if one user gets flagged.

**Architecture:** Three independent, additive changes to `lib/`. (1) New `lib/cloaking.js` module owns billing-header injection (moved out of proxy.js), tool-name suffixing, and Claude Code decoy tools — wired into `proxy.js` request prep + response/stream paths. (2) New `lib/headerCache.js` module captures real Claude Code identity headers from incoming requests and replays them on upstream calls, replacing the static `claude-cli/2.1.63` constants in `proxy.js`. (3) New `pinned_account_id` column on the `users` SQLite table + helpers in `lib/users.js`; `proxy.js` thread the user's pin into `pickActiveAccount` as the highest-priority `preferredAccountId`.

**Tech Stack:** Node.js (ESM), `node:test`/`node:assert` for tests, `better-sqlite3` for the users table, `lowdb` for accounts JSON, `@anthropic-ai/sdk` for upstream calls.

---

## File Structure

**Create:**
- `lib/cloaking.js` — billing header, fake user_id metadata, tool-name suffixing, Claude Code decoy tools, response/stream decloak helpers
- `lib/cloaking.test.js`
- `lib/headerCache.js` — capture & replay of real Claude Code identity headers; persisted to `~/.claude-server/headerCache.json`
- `lib/headerCache.test.js`

**Modify:**
- `lib/proxy.js` — remove inline `applyCloaking`/`generateBillingHeader`/`generateUUID`; import from `cloaking.js`; add `cloakTools`/decloak in request + response paths; replace static client header constants with `getCachedClaudeHeaders()` lookup; thread userEmail-pin into `runWithFailover`
- `lib/users.js` — add `getUserPin`, `setUserPin`, `clearUserPin`, `getOrAssignUserPin` helpers
- `lib/users.test.js` — tests for the four new helpers
- `lib/db.js` — additive ALTER TABLE: `users.pinned_account_id TEXT`
- `lib/accountsStore.js` — no schema change; `pickActiveAccount` already accepts `preferredAccountId` and is sufficient

**Don't touch:**
- `lib/sessionRoutes.js` — keep as-is; per-user pin layers above session pin (session pin still wins inside one conversation, so a mid-conversation fallback stays sticky)
- `lib/translate.js` — decloaking happens before translation; tool names emerge already-clean to the OpenAI translator

---

## Conventions

- Tests use `node:test` and `node:assert/strict`, run via `npm test` (which is `node --test lib/*.test.js`).
- Tests that touch SQLite set `process.env.DATABASE_PATH` BEFORE `await import("./db.js")` so each suite gets a tmp DB. See `lib/users.test.js:1-21` for the canonical pattern.
- Commits use Conventional Commits prefix (look at `git log --oneline` — repo uses `feat(scope):`, `fix(scope):`).
- Never use `--no-verify`. If a hook fails, fix the issue and commit again.

---

# Subsystem 1: Tool-Name Cloaking + Decoys

Largest visible-fingerprint reduction. Pure functions, no DB. Do this first.

## Task 1.1: Extract billing-header + UUID into `lib/cloaking.js`

**Files:**
- Create: `/Users/namtran/Desktop/Workspace/claude-server/lib/cloaking.js`
- Create: `/Users/namtran/Desktop/Workspace/claude-server/lib/cloaking.test.js`

This is a pure refactor of `lib/proxy.js:18-54` into a separate module so it can be tested in isolation and extended with tool cloaking. Behavior must be identical.

- [ ] **Step 1: Write the failing test**

```javascript
// lib/cloaking.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/namtran/Desktop/Workspace/claude-server && npx --no-install node --test lib/cloaking.test.js`
Expected: FAIL with `Cannot find module './cloaking.js'`

- [ ] **Step 3: Implement `lib/cloaking.js` with billing/UUID logic copied from proxy.js**

```javascript
// lib/cloaking.js
import crypto from "node:crypto";

export const CLAUDE_VERSION = "2.1.63";
const BILLING_PREFIX = "x-anthropic-billing-header:";

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/namtran/Desktop/Workspace/claude-server && npx --no-install node --test lib/cloaking.test.js`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
cd /Users/namtran/Desktop/Workspace/claude-server
git add lib/cloaking.js lib/cloaking.test.js
git commit -m "refactor(cloaking): extract billing/UUID logic from proxy.js into testable module"
```

---

## Task 1.2: Add `cloakTools` + decoys to `lib/cloaking.js`

**Files:**
- Modify: `/Users/namtran/Desktop/Workspace/claude-server/lib/cloaking.js`
- Modify: `/Users/namtran/Desktop/Workspace/claude-server/lib/cloaking.test.js`

Cloak the tools array: rename every client tool with a `_ide` suffix (matches 9router's `CLAUDE_TOOL_SUFFIX`), append a fixed list of Claude Code's native tool names as "unavailable" decoys, and rename `tool_use` blocks in message history to match. Returns `{ body, toolNameMap }` so the caller can decloak the response.

- [ ] **Step 1: Write the failing tests**

Append to `lib/cloaking.test.js`:

```javascript
import { cloakTools, decloakResponseToolNames, decloakStreamEvent, CLAUDE_TOOL_SUFFIX, CC_DECOY_TOOL_NAMES } from "./cloaking.js";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/namtran/Desktop/Workspace/claude-server && npx --no-install node --test lib/cloaking.test.js`
Expected: FAIL on the new tests with "cloakTools is not a function" / similar.

- [ ] **Step 3: Implement `cloakTools` + decloak helpers**

Append to `lib/cloaking.js`:

```javascript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/namtran/Desktop/Workspace/claude-server && npx --no-install node --test lib/cloaking.test.js`
Expected: PASS — all 17 tests (7 from 1.1 + 10 from 1.2)

- [ ] **Step 5: Commit**

```bash
cd /Users/namtran/Desktop/Workspace/claude-server
git add lib/cloaking.js lib/cloaking.test.js
git commit -m "feat(cloaking): add tool-name suffixing and Claude Code decoy tools"
```

---

## Task 1.3: Wire cloaking into `lib/proxy.js` request and response paths

**Files:**
- Modify: `/Users/namtran/Desktop/Workspace/claude-server/lib/proxy.js`

Replace inline cloaking with imports from `cloaking.js`. Add tool cloaking to request body and decloaking to response/stream paths. Order matters: cloak tools BEFORE the upstream call; decloak BEFORE format translation (so OpenAI translator sees clean names).

- [ ] **Step 1: Replace inline cloaking with module import**

Edit `lib/proxy.js`. Replace lines 1-54 (imports block + the now-redundant inline `generateBillingHeader` / `generateUUID` / `applyCloaking` definitions) with:

```javascript
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
import {
  applyCloaking,
  cloakTools,
  decloakResponseToolNames,
  decloakStreamEvent,
  CLAUDE_VERSION,
} from "./cloaking.js";
```

Do NOT touch lines 55+ in this step — `parseRetryAfter`, `prepareBody`, `createClient`, `createApiKeyClient`, and the rest of the file stay byte-for-byte identical. (Task 1.3 Step 3 + 4 will edit the request handlers; Task 2.2 will replace `createClient`.)

`prepareBody` already calls `applyCloaking(body, token)` — that call now resolves to the new module export, same behavior.

- [ ] **Step 2: Run existing tests to verify the refactor didn't break anything**

Run: `cd /Users/namtran/Desktop/Workspace/claude-server && npm test`
Expected: PASS — all existing tests still green.

- [ ] **Step 3: Add `cloakTools` + decloak in handleMessages**

Modify `lib/proxy.js:209-306` (the `handleMessages` function). The diff is:

In the inner `runWithFailover` callback (currently around line 232-265), change from:

```javascript
const prepared = prepareBody({ ...reqBody }, token);
ctx.stream = !!prepared.stream;
// ... existing calls to client.messages.create with `prepared`
```

to:

```javascript
const cloaked = cloakTools(prepareBody({ ...reqBody }, token));
const prepared = cloaked.body;
const toolNameMap = cloaked.toolNameMap;
ctx.stream = !!prepared.stream;

// ... when using stream: decloak each event before forwarding
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
```

- [ ] **Step 4: Add `cloakTools` + decloak in handleChatCompletions**

Modify `lib/proxy.js:308-412` (the `handleChatCompletions` function), same shape. Cloaking applies to the Claude-native body (post-translation from OpenAI). Decloak BEFORE the OpenAI translation:

```javascript
const cloaked = cloakTools(prepareBody({ ...claudeBody }, token));
const prepared = cloaked.body;
const toolNameMap = cloaked.toolNameMap;
ctx.stream = !!prepared.stream;

if (prepared.stream) {
  const state = createStreamState();
  const stream = await client.messages.create({ ...prepared, stream: true });
  // ... headers
  for await (const rawEvent of stream) {
    const event = decloakStreamEvent(rawEvent, toolNameMap);
    if (event.type === "message_start" && event.message?.usage) {
      ctx.inputTokens = event.message.usage.input_tokens ?? ctx.inputTokens;
    }
    if (event.type === "message_delta" && event.usage) {
      ctx.outputTokens = event.usage.output_tokens ?? ctx.outputTokens;
    }
    const openaiChunks = claudeStreamChunkToOpenai(event, state);
    if (openaiChunks) for (const chunk of openaiChunks) clientRes.write(`data: ${JSON.stringify(chunk)}\n\n`);
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
```

- [ ] **Step 5: Run all tests to verify nothing broke**

Run: `cd /Users/namtran/Desktop/Workspace/claude-server && npm test`
Expected: PASS — all existing + new tests green.

- [ ] **Step 6: Manual smoke test**

Start the proxy locally: `cd /Users/namtran/Desktop/Workspace/claude-server && npm run dev:proxy &`. Then issue a request with a tool from a real client (or `curl`) and verify the response decloaks correctly:

```bash
curl -s -X POST http://127.0.0.1:8080/v1/messages \
  -H "Authorization: Bearer <YOUR_USER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 256,
    "tools": [
      {"name":"lookup_user","description":"Look up a user by id","input_schema":{"type":"object","properties":{"id":{"type":"integer"}},"required":["id"]}}
    ],
    "messages": [{"role":"user","content":"call lookup_user with id 7"}]
  }' | jq '.content[] | select(.type == "tool_use") | .name'
```

Expected: `"lookup_user"` (NOT `"lookup_user_ide"`). If the suffix appears, decloak is misordered.

Stop the dev proxy.

- [ ] **Step 7: Commit**

```bash
cd /Users/namtran/Desktop/Workspace/claude-server
git add lib/proxy.js
git commit -m "feat(cloaking): wire tool suffix + decoys + decloak into proxy paths"
```

---

# Subsystem 2: Dynamic Header Replay

Replace the static `claude-cli/2.1.63 (external, cli)` User-Agent and the hardcoded `Anthropic-Beta` flag list with headers captured from real Claude Code clients passing through the proxy.

## Task 2.1: Create `lib/headerCache.js` (in-memory + file-backed)

**Files:**
- Create: `/Users/namtran/Desktop/Workspace/claude-server/lib/headerCache.js`
- Create: `/Users/namtran/Desktop/Workspace/claude-server/lib/headerCache.test.js`

Mirror 9router's `claudeHeaderCache.js` but persist captures to disk (under `~/.claude-server/headerCache.json`) so the cache survives proxy restarts.

- [ ] **Step 1: Write the failing test**

```javascript
// lib/headerCache.test.js
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-server-hc-test-"));
process.env.CLAUDE_SERVER_DATA_DIR = tmpDir;

const { cacheClaudeHeaders, getCachedClaudeHeaders, _resetForTests } = await import("./headerCache.js");

beforeEach(() => _resetForTests());
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test("getCachedClaudeHeaders returns null on cold start", () => {
  assert.equal(getCachedClaudeHeaders(), null);
});

test("cacheClaudeHeaders captures when User-Agent contains claude-cli", () => {
  cacheClaudeHeaders({
    "user-agent": "claude-cli/2.1.92 (external, cli)",
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
    "x-stainless-lang": "js",
    "x-app": "cli",
    "content-type": "application/json", // not in allowlist; should be filtered out
  });
  const cached = getCachedClaudeHeaders();
  assert.equal(cached["user-agent"], "claude-cli/2.1.92 (external, cli)");
  assert.equal(cached["anthropic-beta"], "claude-code-20250219,oauth-2025-04-20");
  assert.equal(cached["x-stainless-lang"], "js");
  assert.equal(cached["content-type"], undefined);
});

test("cacheClaudeHeaders ignores requests that don't look like Claude Code", () => {
  cacheClaudeHeaders({
    "user-agent": "curl/8.0",
    "anthropic-beta": "x",
  });
  assert.equal(getCachedClaudeHeaders(), null);
});

test("cacheClaudeHeaders accepts x-app=cli even without claude-cli UA", () => {
  cacheClaudeHeaders({
    "user-agent": "Some-Wrapper/1.0",
    "x-app": "cli",
    "anthropic-beta": "y",
  });
  const cached = getCachedClaudeHeaders();
  assert.ok(cached, "expected to cache when x-app=cli");
});

test("getCachedClaudeHeaders persists across module reload (file-backed)", async () => {
  cacheClaudeHeaders({
    "user-agent": "claude-cli/2.1.99 (external, cli)",
    "anthropic-beta": "fresh-flag",
  });
  // Wait a tick so the write completes
  await new Promise((r) => setImmediate(r));
  // Force re-import by busting the ESM cache (Node's test runner shares module
  // graph, so we reach in via the test hook).
  _resetForTests({ keepFile: true });
  // First lookup after reset should hydrate from disk
  const cached = getCachedClaudeHeaders();
  assert.ok(cached);
  assert.equal(cached["user-agent"], "claude-cli/2.1.99 (external, cli)");
});

test("cacheClaudeHeaders is a no-op when headers is null/non-object", () => {
  cacheClaudeHeaders(null);
  cacheClaudeHeaders(undefined);
  cacheClaudeHeaders("not an object");
  assert.equal(getCachedClaudeHeaders(), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/namtran/Desktop/Workspace/claude-server && npx --no-install node --test lib/headerCache.test.js`
Expected: FAIL — "Cannot find module './headerCache.js'"

- [ ] **Step 3: Implement `lib/headerCache.js`**

```javascript
// lib/headerCache.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLAUDE_IDENTITY_HEADERS = [
  "user-agent",
  "anthropic-beta",
  "anthropic-version",
  "anthropic-dangerous-direct-browser-access",
  "x-app",
  "x-stainless-helper-method",
  "x-stainless-retry-count",
  "x-stainless-runtime-version",
  "x-stainless-package-version",
  "x-stainless-runtime",
  "x-stainless-lang",
  "x-stainless-arch",
  "x-stainless-os",
  "x-stainless-timeout",
  "x-claude-code-session-id",
];

function resolveDataDir() {
  if (process.env.CLAUDE_SERVER_DATA_DIR) return process.env.CLAUDE_SERVER_DATA_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "claude-server");
  }
  return path.join(os.homedir(), ".claude-server");
}

const FILE = path.join(resolveDataDir(), "headerCache.json");

let cached = null;
let hydrated = false;

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    if (fs.existsSync(FILE)) {
      const raw = fs.readFileSync(FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") cached = parsed;
    }
  } catch (err) {
    console.warn(`[headerCache] failed to hydrate ${FILE}: ${err.message}`);
  }
}

function isClaudeCodeClient(headers) {
  const ua = (headers["user-agent"] || "").toLowerCase();
  const xApp = (headers["x-app"] || "").toLowerCase();
  return ua.includes("claude-cli") || ua.includes("claude-code") || xApp === "cli";
}

export function cacheClaudeHeaders(headers) {
  if (!headers || typeof headers !== "object") return;
  if (!isClaudeCodeClient(headers)) return;

  const captured = {};
  for (const key of CLAUDE_IDENTITY_HEADERS) {
    const v = headers[key];
    if (v !== undefined && v !== null) captured[key] = v;
  }
  if (Object.keys(captured).length === 0) return;

  cached = captured;
  hydrated = true;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(captured, null, 2));
    console.log(`[headerCache] cached ${Object.keys(captured).length} identity headers`);
  } catch (err) {
    console.warn(`[headerCache] failed to persist: ${err.message}`);
  }
}

export function getCachedClaudeHeaders() {
  hydrate();
  return cached;
}

// Test hook
export function _resetForTests({ keepFile = false } = {}) {
  cached = null;
  hydrated = false;
  if (!keepFile) {
    try { fs.unlinkSync(FILE); } catch {}
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/namtran/Desktop/Workspace/claude-server && npx --no-install node --test lib/headerCache.test.js`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
cd /Users/namtran/Desktop/Workspace/claude-server
git add lib/headerCache.js lib/headerCache.test.js
git commit -m "feat(headerCache): capture and replay real Claude Code identity headers"
```

---

## Task 2.2: Wire `headerCache` into `lib/proxy.js`

**Files:**
- Modify: `/Users/namtran/Desktop/Workspace/claude-server/lib/proxy.js`

Capture headers on every incoming request (the cache filters non-Claude-Code traffic itself). Replace the static `defaultHeaders` in `createClient` with cached values, falling back to the existing static set on cold start.

- [ ] **Step 1: Add capture call + dynamic header builder**

Edit `lib/proxy.js`:

Add to the imports block:

```javascript
import { cacheClaudeHeaders, getCachedClaudeHeaders } from "./headerCache.js";
```

Replace the existing `createClient` function (around line 86-97) with one that prefers cached headers:

```javascript
function buildClaudeIdentityHeaders() {
  const cached = getCachedClaudeHeaders();
  if (cached) {
    // Replay the captured headers verbatim. Anthropic's SDK sets a few of its
    // own (Authorization, anthropic-version) so we only override what we have.
    const out = {};
    for (const [k, v] of Object.entries(cached)) {
      // Convert lowercase header keys back to Title-Case style the SDK uses
      // for defaultHeaders. The SDK lowercases on send, so casing is cosmetic.
      out[k.split("-").map((s) => s[0].toUpperCase() + s.slice(1)).join("-")] = v;
    }
    return out;
  }
  // Cold-start fallback: use the captured-once-from-real-CC defaults
  return {
    "Anthropic-Beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05",
    "Anthropic-Dangerous-Direct-Browser-Access": "true",
    "User-Agent": `claude-cli/${CLAUDE_VERSION} (external, cli)`,
    "X-App": "cli",
  };
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
```

In both `handleMessages` and `handleChatCompletions`, RIGHT after `inspectRequest(reqHeaders, ...)`, add:

```javascript
cacheClaudeHeaders(reqHeaders);
```

- [ ] **Step 2: Run all tests**

Run: `cd /Users/namtran/Desktop/Workspace/claude-server && npm test`
Expected: PASS — all green.

- [ ] **Step 3: Manual smoke test — cold start**

```bash
cd /Users/namtran/Desktop/Workspace/claude-server
rm -f ~/.claude-server/headerCache.json   # clear any prior capture
npm run dev:proxy &
# In another terminal, send a request with a non-Claude-Code UA and verify
# the proxy still works (uses fallback headers):
curl -s -X POST http://127.0.0.1:8080/v1/messages \
  -H "Authorization: Bearer <YOUR_USER_TOKEN>" \
  -H "User-Agent: my-script/1.0" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":32,"messages":[{"role":"user","content":"hi"}]}' | jq .
# Verify cache file is still absent (no real CC client passed through):
test ! -f ~/.claude-server/headerCache.json && echo "OK: no false capture"
```

- [ ] **Step 4: Manual smoke test — warm start**

```bash
# Now simulate a real Claude Code client passing through to populate the cache:
curl -s -X POST http://127.0.0.1:8080/v1/messages \
  -H "Authorization: Bearer <YOUR_USER_TOKEN>" \
  -H "User-Agent: claude-cli/2.1.92 (external, cli)" \
  -H "Anthropic-Beta: claude-code-20250219,oauth-2025-04-20,test-flag-from-smoke" \
  -H "X-App: cli" \
  -H "X-Stainless-Lang: js" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":32,"messages":[{"role":"user","content":"hi"}]}' | jq -r '.id' >/dev/null
cat ~/.claude-server/headerCache.json
# Expected: file contains the captured headers including "test-flag-from-smoke"
```

Stop the dev proxy.

- [ ] **Step 5: Commit**

```bash
cd /Users/namtran/Desktop/Workspace/claude-server
git add lib/proxy.js
git commit -m "feat(proxy): replay captured Claude Code headers instead of static spoof"
```

---

# Subsystem 3: Per-User Account Pinning

One user → one account, sticky. Bound the blast radius if a user gets flagged.

## Task 3.1: Add `pinned_account_id` column to `users` table

**Files:**
- Modify: `/Users/namtran/Desktop/Workspace/claude-server/lib/db.js`

Additive ALTER TABLE — safe for existing databases.

- [ ] **Step 1: Add column migration**

Edit `lib/db.js`. In `initSchema`, after the existing `addColumn` calls for `request_logs`, add a parallel block for `users`:

```javascript
// users — additive migration for per-user account pinning
const userCols = new Set(
  database.prepare("PRAGMA table_info(users)").all().map((c) => c.name)
);
if (!userCols.has("pinned_account_id")) {
  database.exec(`ALTER TABLE users ADD COLUMN pinned_account_id TEXT`);
}
```

- [ ] **Step 2: Verify the column exists**

Quick smoke check via the repl-style command (no test yet — added in 3.2):

```bash
cd /Users/namtran/Desktop/Workspace/claude-server
node -e '
import("./lib/db.js").then(({ getDb }) => {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  console.log(cols);
});
'
```

Expected output includes `pinned_account_id`.

- [ ] **Step 3: Commit**

```bash
cd /Users/namtran/Desktop/Workspace/claude-server
git add lib/db.js
git commit -m "feat(db): add users.pinned_account_id column for per-user pinning"
```

---

## Task 3.2: Add pin helpers in `lib/users.js`

**Files:**
- Modify: `/Users/namtran/Desktop/Workspace/claude-server/lib/users.js`
- Modify: `/Users/namtran/Desktop/Workspace/claude-server/lib/users.test.js`

Four helpers: `getUserPin`, `setUserPin`, `clearUserPin`, and `getOrAssignUserPin` (the atomic "if no pin exists, pick least-used candidate and persist"). The atomic helper takes the candidate-account list as an argument — keeps `users.js` free of an `accountsStore` import (would be a circular dep risk later).

- [ ] **Step 1: Write the failing tests**

Append to `lib/users.test.js`:

```javascript
import { getUserPin, setUserPin, clearUserPin, getOrAssignUserPin } from "./users.js";

test("getUserPin returns null for users with no pin set", () => {
  upsertUserOnLogin({ email: "pin1@x", name: null, image: null });
  assert.equal(getUserPin("pin1@x"), null);
});

test("setUserPin then getUserPin round-trips", () => {
  upsertUserOnLogin({ email: "pin2@x", name: null, image: null });
  setUserPin("pin2@x", "acct-A");
  assert.equal(getUserPin("pin2@x"), "acct-A");
});

test("setUserPin lowercases email", () => {
  upsertUserOnLogin({ email: "pin3@x", name: null, image: null });
  setUserPin("Pin3@X", "acct-B");
  assert.equal(getUserPin("PIN3@x"), "acct-B");
});

test("clearUserPin removes the pin", () => {
  upsertUserOnLogin({ email: "pin4@x", name: null, image: null });
  setUserPin("pin4@x", "acct-C");
  clearUserPin("pin4@x");
  assert.equal(getUserPin("pin4@x"), null);
});

test("getOrAssignUserPin returns existing pin without picking", () => {
  upsertUserOnLogin({ email: "pin5@x", name: null, image: null });
  setUserPin("pin5@x", "acct-existing");
  const candidates = [
    { id: "acct-X", lastUsedAt: null, createdAt: "2026-01-01T00:00:00Z" },
    { id: "acct-Y", lastUsedAt: null, createdAt: "2026-01-02T00:00:00Z" },
  ];
  assert.equal(getOrAssignUserPin("pin5@x", candidates), "acct-existing");
});

test("getOrAssignUserPin picks least-used candidate when no pin set", () => {
  upsertUserOnLogin({ email: "pin6@x", name: null, image: null });
  // Y was used more recently; X should win.
  const candidates = [
    { id: "acct-X", lastUsedAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
    { id: "acct-Y", lastUsedAt: "2026-05-04T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
  ];
  const pinned = getOrAssignUserPin("pin6@x", candidates);
  assert.equal(pinned, "acct-X");
  // Persisted
  assert.equal(getUserPin("pin6@x"), "acct-X");
});

test("getOrAssignUserPin breaks ties on createdAt (older wins)", () => {
  upsertUserOnLogin({ email: "pin7@x", name: null, image: null });
  const candidates = [
    { id: "acct-newer", lastUsedAt: null, createdAt: "2026-02-01T00:00:00Z" },
    { id: "acct-older", lastUsedAt: null, createdAt: "2026-01-01T00:00:00Z" },
  ];
  assert.equal(getOrAssignUserPin("pin7@x", candidates), "acct-older");
});

test("getOrAssignUserPin returns null when no candidates", () => {
  upsertUserOnLogin({ email: "pin8@x", name: null, image: null });
  assert.equal(getOrAssignUserPin("pin8@x", []), null);
  assert.equal(getUserPin("pin8@x"), null);
});

test("getOrAssignUserPin returns null when user has no row (do not create)", () => {
  // No upsertUserOnLogin for "ghost@x" — pinning should silently no-op rather
  // than auto-creating a user; pin lifetime mirrors row lifetime.
  const candidates = [{ id: "acct-X", lastUsedAt: null, createdAt: "2026-01-01T00:00:00Z" }];
  assert.equal(getOrAssignUserPin("ghost@x", candidates), null);
});

test("getOrAssignUserPin auto-clears stale pin when pinned account is no longer a candidate", () => {
  upsertUserOnLogin({ email: "pin9@x", name: null, image: null });
  setUserPin("pin9@x", "acct-DELETED");
  // Pinned account isn't in the candidate list — repin to least-used available.
  const candidates = [
    { id: "acct-X", lastUsedAt: null, createdAt: "2026-01-01T00:00:00Z" },
    { id: "acct-Y", lastUsedAt: "2026-05-04T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
  ];
  assert.equal(getOrAssignUserPin("pin9@x", candidates), "acct-X");
  assert.equal(getUserPin("pin9@x"), "acct-X");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/namtran/Desktop/Workspace/claude-server && npx --no-install node --test lib/users.test.js`
Expected: FAIL — "getUserPin is not a function" / similar.

- [ ] **Step 3: Implement the helpers in `lib/users.js`**

Append to `lib/users.js`:

```javascript
export function getUserPin(email) {
  if (!email) return null;
  const e = String(email).toLowerCase();
  const db = getDb();
  const row = db.prepare(`SELECT pinned_account_id FROM users WHERE email = ?`).get(e);
  return row?.pinned_account_id || null;
}

export function setUserPin(email, accountId) {
  if (!email) return false;
  const e = String(email).toLowerCase();
  const db = getDb();
  const result = db
    .prepare(`UPDATE users SET pinned_account_id = ? WHERE email = ?`)
    .run(accountId || null, e);
  return result.changes > 0;
}

export function clearUserPin(email) {
  return setUserPin(email, null);
}

/**
 * Return the user's pinned account id, picking and persisting one if none is
 * set or the existing pin is no longer in the candidate list.
 *
 * Picks the candidate with the oldest `lastUsedAt` (nulls first), breaking
 * ties on `createdAt`. Returns null if the user row doesn't exist or no
 * candidates were supplied.
 */
export function getOrAssignUserPin(email, candidates) {
  if (!email) return null;
  const e = String(email).toLowerCase();
  const db = getDb();
  const row = db.prepare(`SELECT pinned_account_id FROM users WHERE email = ?`).get(e);
  if (!row) return null;

  const candidateIds = new Set((candidates || []).map((c) => c.id));
  if (row.pinned_account_id && candidateIds.has(row.pinned_account_id)) {
    return row.pinned_account_id;
  }

  if (!candidates || candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => {
    const at = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
    const bt = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
    if (at !== bt) return at - bt;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
  const chosen = sorted[0];
  db.prepare(`UPDATE users SET pinned_account_id = ? WHERE email = ?`).run(chosen.id, e);
  return chosen.id;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/namtran/Desktop/Workspace/claude-server && npx --no-install node --test lib/users.test.js`
Expected: PASS — 10 new tests + existing tests all green.

- [ ] **Step 5: Commit**

```bash
cd /Users/namtran/Desktop/Workspace/claude-server
git add lib/users.js lib/users.test.js
git commit -m "feat(users): add per-user account pin helpers"
```

---

## Task 3.3: Wire user pin into `lib/proxy.js` failover loop

**Files:**
- Modify: `/Users/namtran/Desktop/Workspace/claude-server/lib/proxy.js`

Compute the user's pin once before the failover loop and pass it as `preferredAccountId`. If `sessionRoutes` already has a route for this conversation, that wins (mid-conversation stickiness). Otherwise the user pin wins. Otherwise round-robin (existing behavior).

- [ ] **Step 1: Add pin lookup + threading**

Edit `lib/proxy.js`.

Add to imports:

```javascript
import { getOrAssignUserPin, clearUserPin } from "./users.js";
```

Modify `runWithFailover` (currently lines 144-207). Change the signature to accept the user's email, and compute the pin before the loop:

```javascript
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
    if (preferredAccountId && preferredAccountId !== account.id && ctx.sessionKey) {
      deleteRoute(ctx.sessionKey);
    }
    console.log(`[proxy] -> using account ${account.name || account.id} (preferred=${preferredAccountId === account.id}, userPin=${userPinId === account.id})`);

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
```

In both `handleMessages` and `handleChatCompletions`, set `ctx.userEmail` after computing `userToken`:

```javascript
const userToken = options.userToken && !options.userToken.bypass ? options.userToken : null;
const reqHeaders = options.reqHeaders || {};
inspectRequest(reqHeaders, reqBody);
cacheClaudeHeaders(reqHeaders);                  // from Subsystem 2
ctx.sessionKey = computeSessionKey(reqHeaders, reqBody, userToken?.id);
ctx.userEmail = userToken?.userEmail || null;    // NEW
ctx.model = reqBody.model || null;
```

(Same lines for `handleChatCompletions`, but with `claudeBody` instead of `reqBody`.)

- [ ] **Step 2: Run all tests**

Run: `cd /Users/namtran/Desktop/Workspace/claude-server && npm test`
Expected: PASS — all green.

- [ ] **Step 3: Manual smoke test — pin assignment**

```bash
cd /Users/namtran/Desktop/Workspace/claude-server
# Pre-conditions: at least 2 active accounts, a signed-in user with a token.
sqlite3 ~/.claude-server/usage.db "SELECT email, pinned_account_id FROM users;"
# Note the rows — pinned_account_id should be NULL for users that haven't
# made a request since this PR.

npm run dev:proxy &
# Send a request as that user:
curl -s -X POST http://127.0.0.1:8080/v1/messages \
  -H "Authorization: Bearer <YOUR_USER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":32,"messages":[{"role":"user","content":"hi"}]}' | jq -r '.id' >/dev/null

# Pin should now be set:
sqlite3 ~/.claude-server/usage.db "SELECT email, pinned_account_id FROM users WHERE email=<YOUR_EMAIL>;"
# Expected: a UUID in pinned_account_id.

# Subsequent requests should use the same account — confirm in logs:
# Look for "[proxy] -> using account ... (preferred=true, userPin=true)"

# Stop the dev proxy.
```

- [ ] **Step 4: Commit**

```bash
cd /Users/namtran/Desktop/Workspace/claude-server
git add lib/proxy.js
git commit -m "feat(proxy): pin each user to one account to bound ban blast radius"
```

---

## Task 3.4: Defensive cleanup — clear pin when pinned account is deleted

**Files:**
- Modify: `/Users/namtran/Desktop/Workspace/claude-server/lib/accountsStore.js`
- Modify: `/Users/namtran/Desktop/Workspace/claude-server/lib/accountsStore.test.js`

Today, deleting an account in the dashboard leaves `users.pinned_account_id` pointing at a missing row. `getOrAssignUserPin` already handles this by repinning, but the stale value lingers in SQLite until the next request. Clean it up at delete time so the dashboard never shows a phantom pin.

- [ ] **Step 1: Read the existing accountsStore tests for context**

Run: `cd /Users/namtran/Desktop/Workspace/claude-server && head -40 lib/accountsStore.test.js` (just to see the env-var pattern they use for tmp dirs).

- [ ] **Step 2: Write the failing test**

Append to `lib/accountsStore.test.js`:

```javascript
import { clearUserPin as _clearPin, getUserPin } from "./users.js";

test("deleteAccount clears any users.pinned_account_id pointing at it", async () => {
  // Need both stores live; users SQLite path was set at top of file via env.
  const acct = await createAccount({ name: "to-delete", accessToken: "sk-ant-oat-x" });
  const { upsertUserOnLogin, setUserPin } = await import("./users.js");
  upsertUserOnLogin({ email: "u@x", name: null, image: null });
  setUserPin("u@x", acct.id);
  assert.equal(getUserPin("u@x"), acct.id);

  await deleteAccount(acct.id);
  assert.equal(getUserPin("u@x"), null);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/namtran/Desktop/Workspace/claude-server && npx --no-install node --test lib/accountsStore.test.js`
Expected: FAIL — pin still set after delete.

- [ ] **Step 4: Modify `deleteAccount` to cascade-clear pins**

Edit `lib/accountsStore.js`. At the top of the file, add a lazy import to avoid a circular-dep risk at module-load time:

```javascript
async function clearPinsForAccount(accountId) {
  // Lazy import: users.js depends on db.js (SQLite); accountsStore.js is the
  // JSON store. They're independent normally, but we don't want to make that
  // dependency direction load-time ordering-sensitive.
  const { getDb } = await import("./db.js");
  const db = getDb();
  db.prepare(`UPDATE users SET pinned_account_id = NULL WHERE pinned_account_id = ?`).run(accountId);
}
```

Modify `deleteAccount` (line 295-301):

```javascript
export async function deleteAccount(id) {
  const removed = await mutate((data) => {
    const before = data.accounts.length;
    data.accounts = data.accounts.filter((a) => a.id !== id);
    return data.accounts.length < before;
  });
  if (removed) {
    try {
      await clearPinsForAccount(id);
    } catch (err) {
      console.warn(`[accounts] failed to clear pins for ${id}: ${err.message}`);
    }
  }
  return removed;
}
```

- [ ] **Step 5: Run all tests to verify they pass**

Run: `cd /Users/namtran/Desktop/Workspace/claude-server && npm test`
Expected: PASS — all green including the new cascade test.

- [ ] **Step 6: Commit**

```bash
cd /Users/namtran/Desktop/Workspace/claude-server
git add lib/accountsStore.js lib/accountsStore.test.js
git commit -m "fix(accounts): clear users.pinned_account_id when its account is deleted"
```

---

# Final Integration Pass

## Task 4.1: Full test sweep + end-to-end smoke

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `cd /Users/namtran/Desktop/Workspace/claude-server && npm test`
Expected: PASS — entire suite green (existing + cloaking + headerCache + users pin + accounts cascade).

- [ ] **Step 2: End-to-end smoke against a live account**

Pre-conditions: at least one active OAuth account in `~/.claude-server/accounts.json` and a user token. Run a real request through the proxy with a Claude Code-style header set, observe the logs, and confirm:

1. `[headerCache] cached N identity headers` appears once per cold start.
2. `[proxy] -> using account ... (preferred=true, userPin=true)` appears on the first authenticated request after applying this PR.
3. The response includes a `tool_use` block with the ORIGINAL (non-suffixed) tool name.
4. `~/.claude-server/headerCache.json` exists and contains the captured headers.
5. The user's row in SQLite has `pinned_account_id` set to a valid account UUID.

```bash
cd /Users/namtran/Desktop/Workspace/claude-server
npm run dev:proxy &
# Run the curl from Task 1.3 step 6 with the Claude Code UA from Task 2.2 step 4.
# Then check:
sqlite3 ~/.claude-server/usage.db "SELECT email, pinned_account_id FROM users WHERE pinned_account_id IS NOT NULL;"
ls -la ~/.claude-server/headerCache.json
# Stop the dev proxy.
```

- [ ] **Step 3: Update README (one section about anti-ban posture)**

Edit `/Users/namtran/Desktop/Workspace/claude-server/README.md`. After the "Multi-Account Fallback" section, add:

```markdown
## Anti-Ban Posture

This proxy takes several steps to reduce the chance Anthropic flags the upstream OAuth accounts:

- **Per-user account pinning** — each user is pinned to one account on their first request and re-uses it for every subsequent request. If one user gets flagged, the blast radius is one account, not all of them. The pin is cleared automatically if its account is deleted.
- **Tool-name cloaking + Claude Code decoys** — every client tool is renamed with an `_ide` suffix and the canonical Claude Code tool surface (Bash, Read, Write, Task, …) is appended as "unavailable" decoys, so requests look like genuine Claude Code from the upstream's perspective.
- **Dynamic header replay** — when a real Claude Code client passes through the proxy, its identity headers (`User-Agent`, `Anthropic-Beta`, `X-Stainless-*`, etc.) are captured to `~/.claude-server/headerCache.json` and replayed on subsequent OAuth-mode upstream calls. Falls back to a hardcoded `claude-cli/2.1.63` set on cold start.
- **Billing header + fake user_id** — every OAuth-mode request has a `cc_version=…; cc_entrypoint=cli; cch=…` block injected as the first system message and a UUID injected as `metadata.user_id`, matching the format real Claude Code emits.

None of this changes Anthropic's terms-of-service position on running a multi-user proxy in front of a personal subscription. It only reduces the operational signals that make detection easy.
```

- [ ] **Step 4: Commit**

```bash
cd /Users/namtran/Desktop/Workspace/claude-server
git add README.md
git commit -m "docs(readme): document anti-ban posture (pinning, cloaking, header replay)"
```

---

# Out of Scope (deliberate)

The original triage flagged seven candidate improvements. This plan implements three:
- **#1** Per-user account pinning ✅
- **#2** Dynamic header replay ✅
- **#3** Tool-name cloaking + decoys ✅

The remaining four are deliberately deferred:
- **#4** Per-user quotas + abuse detection — needs a separate brainstorm to decide on quota dimensions and enforcement points.
- **#5** Refresh jitter + staggering — small, easy follow-up; not blocking.
- **#6** Burned-account detection (multi-hour cooldown after N consecutive 4xx) — useful but invasive; defer until the existing exponential backoff proves insufficient.
- **#7** RTK-style tool-result compression — non-trivial, low impact on ban risk specifically.

Operators who want a manual escape hatch for pinning can edit SQLite directly:
```bash
sqlite3 ~/.claude-server/usage.db "UPDATE users SET pinned_account_id = NULL WHERE email = '<email>';"
```
A dashboard UI for this is a possible follow-up but not part of this plan.
