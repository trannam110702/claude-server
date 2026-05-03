import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { listAccounts, ACCOUNTS_DB_FILE, ClaudeAccount } from "@/lib/db";

function redact(account: ClaudeAccount & Record<string, unknown>) {
  const modelLocks: Array<{ model: string; until: string }> = [];
  let earliestLockUntil: string | null = null;
  for (const [k, v] of Object.entries(account)) {
    if (!k.startsWith("modelLock_") || !v || typeof v !== "string") continue;
    const t = new Date(v).getTime();
    if (!Number.isFinite(t) || t <= Date.now()) continue;
    const model = k === "modelLock___all" ? "*" : k.slice("modelLock_".length);
    modelLocks.push({ model, until: v });
    if (!earliestLockUntil || t < new Date(earliestLockUntil).getTime()) {
      earliestLockUntil = v;
    }
  }
  modelLocks.sort((a, b) => new Date(a.until).getTime() - new Date(b.until).getTime());

  return {
    id: account.id,
    name: account.name,
    email: account.email,
    expiresAt: account.expiresAt,
    isActive: account.isActive,
    lastUsedAt: account.lastUsedAt,
    lastError: account.lastError,
    lastErrorAt: account.lastErrorAt,
    errorCode: (account as { errorCode?: number | null }).errorCode ?? null,
    backoffLevel: (account as { backoffLevel?: number }).backoffLevel ?? 0,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    accessTokenPreview: account.accessToken
      ? `${account.accessToken.slice(0, 12)}…${account.accessToken.slice(-4)}`
      : null,
    hasRefreshToken: !!account.refreshToken,
    modelLocks,
    earliestLockUntil,
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const all = (await listAccounts()) as Array<ClaudeAccount & Record<string, unknown>>;
  console.log(`[accounts:list] reading from ${ACCOUNTS_DB_FILE}, returning ${all.length} account(s)`);
  return NextResponse.json({ accounts: all.map(redact) });
}
