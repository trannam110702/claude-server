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
