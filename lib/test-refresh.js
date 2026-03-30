import { readTokens, saveTokens } from "./login.js";

const tokens = readTokens();
if (!tokens?.refreshToken) {
  console.error("No refresh token found in tokens.json. Run 'npm run login' first.");
  process.exit(1);
}

console.log(`Current access token: ${tokens.accessToken?.slice(0, 25)}...`);
console.log(`Current refresh token: ${tokens.refreshToken?.slice(0, 25)}...`);
console.log(`Expires at: ${tokens.expiresAt || "unknown"}\n`);
console.log("Requesting new tokens...\n");

const response = await fetch("https://api.anthropic.com/v1/oauth/token", {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: tokens.clientId || "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  }),
});

if (!response.ok) {
  const errorText = await response.text();
  console.error(`Refresh failed (${response.status}): ${errorText}`);
  console.error("\nRefresh token may be expired. Run 'npm run login' to re-authenticate.");
  process.exit(1);
}

const result = await response.json();

saveTokens({
  accessToken: result.access_token,
  refreshToken: result.refresh_token || tokens.refreshToken,
  expiresAt: result.expires_in
    ? new Date(Date.now() + result.expires_in * 1000).toISOString()
    : null,
});

console.log("Token refresh successful!");
console.log(`New access token: ${result.access_token.slice(0, 25)}...`);
if (result.refresh_token) {
  console.log(`New refresh token: ${result.refresh_token.slice(0, 25)}...`);
}
if (result.expires_in) {
  console.log(`Expires in: ${Math.round(result.expires_in / 60)} minutes`);
}
console.log("\nTokens saved to tokens.json.");
