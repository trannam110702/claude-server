import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  getAccount,
  updateAccount,
  deleteAccount,
  ensureFreshAccount,
  ClaudeAccount,
} from "@/lib/db";
// @ts-ignore - JS module
import { fetchClaudeProfile, fetchClaudeUsage } from "../../../../../../lib/usage.js";
// @ts-ignore - JS module
import { getDb } from "../../../../../../lib/db.js";

function redact(account: ClaudeAccount) {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    fullName: account.fullName,
    organizationName: account.organizationName,
    organizationId: account.organizationId,
    accountUuid: account.accountUuid,
    plan: account.plan,
    isActive: account.isActive,
    scope: account.scope,
    expiresAt: account.expiresAt,
    lastUsedAt: account.lastUsedAt,
    lastError: account.lastError,
    lastErrorAt: account.lastErrorAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    accessTokenPreview: account.accessToken
      ? `${account.accessToken.slice(0, 12)}…${account.accessToken.slice(-4)}`
      : null,
    hasRefreshToken: !!account.refreshToken,
  };
}

/**
 * GET /api/claude/accounts/[id]
 * Returns the full stored account record plus a live profile lookup, live
 * quota usage, and historical request stats from request_logs. The Account
 * detail dialog on /dashboard/accounts uses this endpoint.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  let account = (await getAccount(id)) as ClaudeAccount | null;
  if (!account) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Ensure the access token is fresh before talking to Anthropic; ignore
  // refresh errors so we still return the stored data.
  try {
    const fresh = await ensureFreshAccount(account);
    if (fresh) account = fresh as ClaudeAccount;
  } catch {}

  type Profile = {
    email?: string | null;
    fullName?: string | null;
    organizationName?: string | null;
    organizationId?: string | null;
    accountUuid?: string | null;
    [k: string]: unknown;
  };
  type UsageResp = { error?: string; [k: string]: unknown };

  const [profile, usage] = (await Promise.all([
    fetchClaudeProfile(account.accessToken).catch(() => ({})),
    fetchClaudeUsage(account.accessToken).catch((err: Error) => ({ error: err.message })),
  ])) as [Profile, UsageResp];

  // If we just discovered new identity fields (e.g. a legacy account that was
  // imported without them), persist them so future loads are instant.
  const updates: Record<string, unknown> = {};
  if (!account.email && profile.email) updates.email = profile.email;
  if (!account.fullName && profile.fullName) updates.fullName = profile.fullName;
  if (!account.organizationName && profile.organizationName) updates.organizationName = profile.organizationName;
  if (!account.organizationId && profile.organizationId) updates.organizationId = profile.organizationId;
  if (!account.accountUuid && profile.accountUuid) updates.accountUuid = profile.accountUuid;
  if (Object.keys(updates).length > 0) {
    const refreshed = (await updateAccount(id, updates)) as ClaudeAccount | null;
    if (refreshed) account = refreshed;
  }

  // Historical activity from request_logs (totals + last-24h).
  const db = getDb();
  const cutoff24h = new Date(Date.now() - 86_400_000).toISOString();
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS requests,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
         MAX(timestamp) AS last_request_at
       FROM request_logs WHERE account_id = ?`
    )
    .get(id);
  const last24h = db
    .prepare(
      `SELECT
         COUNT(*) AS requests,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens
       FROM request_logs WHERE account_id = ? AND timestamp >= ?`
    )
    .get(id, cutoff24h);

  return NextResponse.json({
    account: redact(account),
    profile,
    usage,
    activity: {
      total: totals,
      last24h,
    },
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }
  const { id } = await params;
  const account = await getAccount(id);
  if (!account) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: { name?: string; isActive?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fields: Record<string, unknown> = {};
  if (typeof body.name === "string") fields.name = body.name.trim();
  if (typeof body.isActive === "boolean") fields.isActive = body.isActive;

  const updated = await updateAccount(id, fields);
  if (!updated) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({
    account: {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      isActive: updated.isActive,
      expiresAt: updated.expiresAt,
    },
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }
  const { id } = await params;
  const ok = await deleteAccount(id);
  if (!ok) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
