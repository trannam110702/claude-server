/**
 * Claude account quota fetcher — ported from 9router/open-sse/services/usage.js.
 * Hits Anthropic's OAuth usage endpoint and normalizes the response into
 * { plan, quotas: { "session (5h)": { used, total, remaining, resetAt, ... } } }.
 */

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Best-effort: fetch the Claude account's full profile.
 * Returns { email, displayName, fullName, organizationName, organizationId,
 *           accountUuid, raw } when available, or {} otherwise.
 *
 * Anthropic shape (observed): {
 *   account: { uuid, email_address, full_name, display_name },
 *   organization: { uuid, name }
 * }
 * — but kept defensive in case the schema shifts.
 */
export async function fetchClaudeProfile(accessToken) {
  if (!accessToken) return {};
  try {
    const response = await fetch(CLAUDE_PROFILE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": ANTHROPIC_VERSION,
      },
    });
    if (!response.ok) return {};
    const data = await response.json();

    const email =
      data?.account?.email_address ||
      data?.account?.email ||
      data?.email ||
      data?.email_address ||
      null;
    const displayName =
      data?.account?.display_name ||
      data?.account?.name ||
      data?.display_name ||
      data?.name ||
      null;
    const fullName =
      data?.account?.full_name ||
      data?.full_name ||
      null;
    const organizationName =
      data?.organization?.name ||
      data?.organization_name ||
      null;
    const organizationId =
      data?.organization?.uuid ||
      data?.organization?.id ||
      data?.organization_id ||
      null;
    const accountUuid =
      data?.account?.uuid ||
      data?.account?.id ||
      null;

    return { email, displayName, fullName, organizationName, organizationId, accountUuid, raw: data };
  } catch {
    return {};
  }
}

function parseResetTime(resetValue) {
  if (!resetValue) return null;
  try {
    if (resetValue instanceof Date) return resetValue.toISOString();
    if (typeof resetValue === "number") {
      return new Date(resetValue < 1e12 ? resetValue * 1000 : resetValue).toISOString();
    }
    if (typeof resetValue === "string") {
      if (/^\d+$/.test(resetValue)) {
        const ts = Number(resetValue);
        return new Date(ts < 1e12 ? ts * 1000 : ts).toISOString();
      }
      return new Date(resetValue).toISOString();
    }
    return null;
  } catch {
    return null;
  }
}

const hasUtilization = (window) =>
  window && typeof window === "object" && typeof window.utilization === "number";

function createQuotaObject(window) {
  const used = window.utilization;
  const remaining = Math.max(0, 100 - used);
  return {
    used,
    total: 100,
    remaining,
    remainingPercentage: remaining,
    resetAt: parseResetTime(window.resets_at),
    unlimited: false,
  };
}

/**
 * @param {string} accessToken Claude OAuth access token (sk-ant-oat…)
 * @returns {Promise<{plan: string, extraUsage: any, quotas: Record<string, object>} | {error: string}>}
 */
export async function fetchClaudeUsage(accessToken) {
  if (!accessToken) return { error: "missing access token" };

  let response;
  try {
    response = await fetch(CLAUDE_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": ANTHROPIC_VERSION,
      },
    });
  } catch (err) {
    return { error: `network: ${err.message}` };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      error: `Anthropic returned ${response.status}: ${text.slice(0, 200)}`,
      status: response.status,
    };
  }

  const data = await response.json();
  const quotas = {};

  if (hasUtilization(data.five_hour)) {
    quotas["session (5h)"] = createQuotaObject(data.five_hour);
  }
  if (hasUtilization(data.seven_day)) {
    quotas["weekly (7d)"] = createQuotaObject(data.seven_day);
  }
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith("seven_day_") && key !== "seven_day" && hasUtilization(value)) {
      const modelName = key.replace("seven_day_", "");
      quotas[`weekly ${modelName} (7d)`] = createQuotaObject(value);
    }
  }

  return {
    plan: "Claude Code",
    extraUsage: data.extra_usage ?? null,
    quotas,
    fetchedAt: new Date().toISOString(),
  };
}
