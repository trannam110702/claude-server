/**
 * One-shot request inspector: when INSPECT_REQUESTS=N is set, the next N
 * /v1/messages requests are logged to ~/.claude-server/request-inspect.log
 * with headers + metadata + message shape (NO content). Used to discover
 * what stable identifiers Claude Code CLI emits.
 *
 * Disable by removing the env var. Counter persists in memory only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function resolveDataDir() {
  if (process.env.CLAUDE_SERVER_DATA_DIR) return process.env.CLAUDE_SERVER_DATA_DIR;
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "claude-server"
    );
  }
  return path.join(os.homedir(), ".claude-server");
}

const LOG_FILE = path.join(resolveDataDir(), "request-inspect.log");
let remaining = parseInt(process.env.INSPECT_REQUESTS || "0", 10);
if (!Number.isFinite(remaining) || remaining < 0) remaining = 0;

function safeBodyShape(body) {
  if (!body || typeof body !== "object") return null;
  const messages = Array.isArray(body.messages)
    ? body.messages.map((m) => ({
        role: m.role,
        content_type: typeof m.content,
        content_length: typeof m.content === "string" ? m.content.length : Array.isArray(m.content) ? m.content.length : 0,
      }))
    : [];
  return {
    model: body.model,
    has_system: !!body.system,
    system_type: typeof body.system,
    system_length: typeof body.system === "string"
      ? body.system.length
      : Array.isArray(body.system) ? body.system.length : 0,
    metadata: body.metadata || null,
    messages_count: messages.length,
    messages_shape: messages,
    first_message_preview: typeof body.messages?.[0]?.content === "string"
      ? body.messages[0].content.slice(0, 200)
      : null,
  };
}

export function inspectRequest(headers, body) {
  if (remaining <= 0) return;
  try {
    const lowerHeaders = {};
    for (const [k, v] of Object.entries(headers || {})) lowerHeaders[k.toLowerCase()] = v;
    const entry = {
      ts: new Date().toISOString(),
      headers: lowerHeaders,
      body_shape: safeBodyShape(body),
    };
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
    remaining--;
    if (remaining === 0) {
      fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), note: "inspector complete, stopping" }) + "\n");
      console.log(`[inspector] captured all configured requests; logged to ${LOG_FILE}`);
    }
  } catch (e) {
    console.warn("[inspector] failed:", e.message);
  }
}

export function isInspecting() {
  return remaining > 0;
}
