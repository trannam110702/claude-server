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

  const serialized = JSON.stringify(captured);
  if (cached && JSON.stringify(cached) === serialized) return;

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
