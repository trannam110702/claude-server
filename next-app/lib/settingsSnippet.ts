export const TOKEN_PLACEHOLDER = "<YOUR_API_TOKEN>";
export const URL_PLACEHOLDER = "<YOUR_PROXY_URL>";

export function buildSettingsSnippet(baseUrl: string, token: string): string {
  return JSON.stringify(
    {
      env: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: token,
      },
    },
    null,
    2,
  );
}

// In dev, accessing the dashboard at Next.js's port 3000 bypasses the Express
// proxy on 8080, so the snippet would point Claude Code at the wrong port.
export function isLikelyDevPortMismatch(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).port === "3000";
  } catch {
    return false;
  }
}
