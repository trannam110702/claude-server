import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { platform, homedir } from "node:os";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/**
 * Read Claude Code OAuth credentials from the OS keychain.
 * Claude Code stores them under service "Claude Code-credentials".
 */
function readFromKeychain() {
  const os = platform();

  if (os === "darwin") {
    // macOS: security CLI
    const raw = execSync(
      `security find-generic-password -s "Claude Code-credentials" -w`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    return JSON.parse(raw);
  }

  if (os === "linux") {
    // Linux: secret-tool (libsecret) or check plaintext file
    try {
      const raw = execSync(
        `secret-tool lookup service "Claude Code-credentials"`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      return JSON.parse(raw);
    } catch {
      // Fallback: check ~/.claude credentials file
      const credPath = `${homedir()}/.claude/credentials.json`;
      return JSON.parse(readFileSync(credPath, "utf-8"));
    }
  }

  throw new Error(`Unsupported platform: ${os}. Manually set tokens in .env`);
}

function updateEnvFile(accessToken, refreshToken) {
  const envPath = new URL("../.env", import.meta.url).pathname;
  let content = "";
  try {
    content = readFileSync(envPath, "utf-8");
  } catch { /* new file */ }

  const updates = {
    OAUTH_ACCESS_TOKEN: accessToken,
    OAUTH_REFRESH_TOKEN: refreshToken,
    OAUTH_CLIENT_ID: CLIENT_ID,
  };

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `${content.endsWith("\n") ? "" : "\n"}${key}=${value}\n`;
    }
  }

  writeFileSync(envPath, content);
}

export async function login() {
  console.log("Reading tokens from Claude Code keychain...");

  const credentials = readFromKeychain();
  const oauth = credentials.claudeAiOauth;

  if (!oauth?.accessToken || !oauth?.refreshToken) {
    console.error("No OAuth tokens found. Make sure Claude Code is logged in (`claude auth login`).");
    process.exit(1);
  }

  updateEnvFile(oauth.accessToken, oauth.refreshToken);

  console.log("Tokens saved to .env!");
  console.log(`Access token: ${oauth.accessToken.slice(0, 25)}...`);
  console.log(`Refresh token: ${oauth.refreshToken.slice(0, 25)}...`);
}
