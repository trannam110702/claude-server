import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { listAccounts, ACCOUNTS_DB_FILE, ClaudeAccount } from "@/lib/db";

function redact(account: ClaudeAccount) {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    expiresAt: account.expiresAt,
    isActive: account.isActive,
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

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const all = (await listAccounts()) as ClaudeAccount[];
  console.log(`[accounts:list] reading from ${ACCOUNTS_DB_FILE}, returning ${all.length} account(s)`);
  return NextResponse.json({ accounts: all.map(redact) });
}
